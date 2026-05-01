import config from "../../agent/config.js";

const { MAX_STRIKES, MIN_CYCLES, MAX_CYCLE_PERIOD } = config;

const CONTRACT_REMINDER = "Missing update";
const STAGNATION_FREE_TURNS = 3;
const PHASES = [4, 5, 6, 7, 8, 9];
const TURN_FROM_PATH = /^log:\/\/turn_(\d+)\//;

function phaseForStatus(status) {
	if (status == null) return 4;
	if (status === 200) return 7;
	const last = status % 10;
	return PHASES.includes(last) ? last : 4;
}

// Walk update entries from earlier turns, find the latest non-rejected
// status, and resolve to a phase number. Mirrors instructions.js's
// #getCurrentPhase; replicated here to avoid an inter-plugin dependency.
async function currentPhase(rummy) {
	const updates = await rummy.entries.getEntriesByPattern(
		rummy.runId,
		"log://*/update/**",
		null,
	);
	let bestTurn = -1;
	let bestStatus = null;
	for (const e of updates) {
		const m = TURN_FROM_PATH.exec(e.path);
		if (!m) continue;
		const turn = Number(m[1]);
		if (turn >= rummy.sequence) continue;
		const attrs =
			typeof e.attributes === "string"
				? JSON.parse(e.attributes)
				: e.attributes;
		if (attrs?.rejected) continue;
		if (attrs?.status == null) continue;
		if (turn > bestTurn) {
			bestTurn = turn;
			bestStatus = attrs.status;
		}
	}
	return phaseForStatus(bestStatus);
}

function fingerprint(entry) {
	const parts = Object.keys(entry.attributes)
		.toSorted()
		.filter((k) => entry.attributes[k] != null)
		.map((k) => `${k}=${entry.attributes[k]}`);
	return `${entry.scheme}:${parts.join(",")}`;
}

function detectCycle(history) {
	for (let k = 1; k <= MAX_CYCLE_PERIOD; k++) {
		const needed = k * MIN_CYCLES;
		if (history.length < needed) continue;
		const tail = history.slice(-needed);
		const cycle = tail.slice(0, k);
		let match = true;
		outer: for (let rep = 0; rep < MIN_CYCLES; rep++) {
			for (let j = 0; j < k; j++) {
				if (tail[rep * k + j] !== cycle[j]) {
					match = false;
					break outer;
				}
			}
		}
		if (match) return { detected: true, period: k, cycles: MIN_CYCLES };
	}
	return { detected: false };
}

export default class ErrorPlugin {
	#core;
	#loopState = new Map();

	constructor(core) {
		this.#core = core;
		core.registerScheme({ category: "logging" });
		core.on("visible", (entry) => `# error\n${entry.body}`);
		core.on("summarized", (entry) => entry.body);

		core.hooks.error.log.on(this.#onErrorLog.bind(this));
		core.hooks.loop.started.on(this.#onLoopStarted.bind(this));
		core.hooks.loop.completed.on(this.#onLoopCompleted.bind(this));
		core.hooks.turn.started.on(this.#onTurnStarted.bind(this));

		core.hooks.error.verdict = this.#verdict.bind(this);
	}

	#onLoopStarted({ loopId }) {
		this.#loopState.set(loopId, {
			streak: 0,
			history: [],
			turnErrors: 0,
			currentPhase: null,
			phaseTurnCount: 0,
		});
	}

	#onLoopCompleted({ loopId }) {
		this.#loopState.delete(loopId);
	}

	// Per-stage stagnation pressure: turns 1–3 in the same phase are free,
	// each turn after that fires a strike via the same error.log channel
	// as parser/contract failures. The model sees the strike entry in its
	// next turn's context and feels the same accumulating consequence —
	// MAX_STRIKES still gates abandonment.
	async #onTurnStarted({ rummy }) {
		const state = this.#loopState.get(rummy.loopId);
		state.turnErrors = 0;

		const phase = await currentPhase(rummy);
		if (phase === state.currentPhase) {
			state.phaseTurnCount++;
		} else {
			state.currentPhase = phase;
			state.phaseTurnCount = 1;
		}

		if (state.phaseTurnCount > STAGNATION_FREE_TURNS) {
			await rummy.hooks.error.log.emit({
				store: rummy.entries,
				runId: rummy.runId,
				turn: rummy.sequence,
				loopId: rummy.loopId,
				message: `${state.phaseTurnCount} turns in current stage. Attempt to proceed to next stage.`,
				status: 408,
				attributes: { stagnation: true, phase },
			});
		}
	}

	async #onErrorLog({
		store,
		runId,
		turn,
		loopId,
		message,
		status,
		attributes,
		soft,
	}) {
		const statusValue = status ?? 400;
		const path = await store.logPath(runId, turn, "error", message);
		// Soft errors record but don't strike: the issue was already
		// recovered (e.g. parser auto-corrected a closing-tag mismatch)
		// and the entry exists only so the model can see what happened.
		// state="resolved" keeps recordedFailed clean; skipping
		// turnErrors++ keeps the strike machinery from firing. Per SPEC
		// #entries, outcome is reserved for state ∈ {failed, cancelled}
		// — soft entries land with outcome=null. Status carrier for
		// rendering is attributes.status, consulted before outcome by
		// log.js's renderLogTag.
		await store.set({
			runId,
			turn,
			path,
			body: message,
			state: soft ? "resolved" : "failed",
			outcome: soft ? null : `status:${statusValue}`,
			loopId,
			attributes: { ...attributes, status: statusValue },
		});
		if (soft) return;
		const state = this.#loopState.get(loopId);
		if (state) state.turnErrors++;
	}

	async #verdict({ store, runId, loopId, recorded, summaryText }) {
		const state = this.#loopState.get(loopId);

		let cycleReason = null;
		// Empty turns share a blank fingerprint; intentional.
		const fp = recorded.map(fingerprint).toSorted().join("|");
		state.history.push(fp);
		const cycle = detectCycle(state.history);
		if (cycle.detected) {
			cycleReason = "Loop detected";
			// Silent strike: increment turn-errors without a model-facing entry.
			state.turnErrors++;
		}

		let recordedFailed = false;
		for (const e of recorded) {
			const current = await store.getState(runId, e.path);
			if (current?.state === "failed") {
				recordedFailed = true;
				break;
			}
		}
		const struck = state.turnErrors > 0 || recordedFailed;

		if (summaryText && !struck) {
			state.streak = 0;
			const updateEntry = recorded?.findLast?.((e) => e.scheme === "update");
			const terminalStatus = updateEntry?.attributes?.status ?? 200;
			return { continue: false, status: terminalStatus };
		}

		if (struck) {
			state.streak++;
			if (state.streak >= MAX_STRIKES) {
				// Abandoning-strike turn: same-turn terminal update wins over 499.
				if (summaryText) {
					state.streak = 0;
					const updateEntry = recorded?.findLast?.(
						(e) => e.scheme === "update",
					);
					const terminalStatus = updateEntry?.attributes?.status ?? 200;
					return { continue: false, status: terminalStatus };
				}
				return {
					continue: false,
					status: 499,
					reason:
						cycleReason ||
						`Abandoned after ${state.streak} consecutive strikes.`,
				};
			}
			return {
				continue: true,
				reason: CONTRACT_REMINDER,
			};
		}

		state.streak = 0;
		return { continue: true };
	}
}
