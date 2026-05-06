import { SUMMARY_MAX_CHARS } from "../helpers.js";

const MAX_STRIKES = Number(process.env.RUMMY_MAX_STRIKES);
const MIN_CYCLES = Number(process.env.RUMMY_MIN_CYCLES);
const MAX_CYCLE_PERIOD = Number(process.env.RUMMY_MAX_CYCLE_PERIOD);

// Failure outcomes that don't accumulate strikes — they're findings
// the model adapts to, not contract violations. See verdict() for usage.
const SOFT_FAILURE_OUTCOMES = new Set(["not_found", "conflict"]);

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
		core.on("summarized", (entry) => entry.body.slice(0, SUMMARY_MAX_CHARS));

		core.hooks.error.log.on(this.#onErrorLog.bind(this));
		core.hooks.loop.started.on(this.#onLoopStarted.bind(this));
		core.hooks.loop.completed.on(this.#onLoopCompleted.bind(this));
		core.hooks.turn.started.on(this.#onTurnStarted.bind(this));

		// Subscribe to the turn.verdict filter chain. Multi-plugin
		// surface — strike streak, cycle detection, stagnation
		// pressure all flow through here. Future voters (e.g. budget
		// overflow termination, runaway-on-context-grow) participate
		// via the same chain.
		core.filter("turn.verdict", this.#verdict.bind(this));
	}

	#onLoopStarted({ loopId }) {
		this.#loopState.set(loopId, {
			streak: 0,
			history: [],
			turnErrors: 0,
		});
	}

	#onLoopCompleted({ loopId }) {
		this.#loopState.delete(loopId);
	}

	#onTurnStarted({ rummy }) {
		const state = this.#loopState.get(rummy.loopId);
		state.turnErrors = 0;
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

	async #verdict(
		_currentVerdict,
		{ store, runId, loopId, recorded, summaryText, turn: _turn },
	) {
		// _currentVerdict is the upstream filter's result. Today this is
		// the only voter so it's always { continue: true }. When other
		// plugins join the chain, they can short-circuit by setting
		// continue=false; this implementation could honor that via an
		// early return. Left noop for now to preserve current semantics.
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

		// Some failure outcomes are findings the model should adapt to,
		// not contract violations. `not_found` (model tried to act on an
		// entry that doesn't exist) and `conflict` (SEARCH text didn't
		// match current body) are recoverable: the model reads the new
		// state and tries again. Striking on these punishes legitimate
		// state-discovery and accumulates 499s on otherwise productive
		// runs. Hard outcomes (validation, permission, exit:N) still strike.
		let recordedFailed = false;
		for (const e of recorded) {
			const current = await store.getState(runId, e.path);
			if (
				current?.state === "failed" &&
				!SOFT_FAILURE_OUTCOMES.has(current.outcome)
			) {
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
			// No reason on continue: the model sees the actual failure
			// entries directly in <log> next turn. Hardcoding "Missing
			// update" mislabels strikes that fire on validation /
			// permission / dispatch failures or cycles, when the update
			// itself was emitted correctly.
			return { continue: true };
		}

		state.streak = 0;
		return { continue: true };
	}
}
