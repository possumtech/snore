import config from "../../agent/config.js";

const { MAX_STRIKES, MIN_CYCLES, MAX_CYCLE_PERIOD, STAGNATION_FREE_TURNS } =
	config;

const CONTRACT_REMINDER = "Missing update";
// Failure outcomes that don't accumulate strikes — they're findings
// the model adapts to, not contract violations. See verdict() for usage.
const SOFT_FAILURE_OUTCOMES = new Set(["not_found", "conflict"]);
// Stagnation pressure applies only to the admin phases — Decomposition
// (defining unknowns) and Demotion (archiving irrelevants). Staying
// long there is genuinely stuck. Distillation (5) and Deployment (7)
// are work phases where grinding on a hard sub-problem is legitimate;
// the strike system must not punish that.
const STAGNATION_PHASES = new Set([4, 6]);
const PHASES = [4, 5, 6, 7, 8, 9];

function phaseForStatus(status) {
	if (status == null) return 4;
	if (status === 200) return 7;
	const last = status % 10;
	return PHASES.includes(last) ? last : 4;
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
			// FCRM starts at Decomposition (phase 4) by convention. Seeding
			// here so a loop's first turn-with-no-update doesn't get an
			// undefined-phase free pass — a model that never emits an
			// update at all should still accumulate Decomposition stagnation.
			currentPhase: 4,
			phaseTurnCount: 0,
		});
	}

	#onLoopCompleted({ loopId }) {
		this.#loopState.delete(loopId);
	}

	#onTurnStarted({ rummy }) {
		const state = this.#loopState.get(rummy.loopId);
		state.turnErrors = 0;
		// Stagnation pressure (admin-phase repeat counter) moved to
		// #verdict so the model's actual emission decides whether it
		// advanced. Pre-firing at turn-start computed phase from the
		// PRIOR turn (`currentPhase()` skips the in-flight turn) and
		// punished the model for staying-put even when the model
		// emitted a phase-advance update on the very same turn —
		// striking through to MAX_STRIKES and blocking the rescue
		// branch from honoring the advance. Verified pathology:
		// 2026-05-01 e2e lite-mode test, gemma turns 14-17 (model
		// emitted status=167 advance on turn 17 but the strike streak
		// from prior pre-fires already hit 3 → 499 abandon). Locked
		// in via FCRM scope rule: penalize what the model actually
		// did, not what the harness predicted it would do.
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

	async #verdict({ store, runId, turn, loopId, recorded, summaryText }) {
		const state = this.#loopState.get(loopId);

		// Per-stage stagnation pressure: admin-phase turns 1–3 are free,
		// each turn after that fires a 408 strike via error.log. Phase
		// is computed from THIS turn's recorded update — the model's
		// own emission decides whether it advanced. A turn with no
		// update inherits the prior phase (model didn't communicate).
		const updateEntry = recorded.findLast((e) => e.scheme === "update");
		const updateStatus = updateEntry?.attributes?.status;
		const newPhase =
			updateStatus == null ? state.currentPhase : phaseForStatus(updateStatus);
		if (newPhase === state.currentPhase) {
			state.phaseTurnCount++;
		} else {
			state.currentPhase = newPhase;
			state.phaseTurnCount = 1;
		}
		if (
			STAGNATION_PHASES.has(newPhase) &&
			state.phaseTurnCount > STAGNATION_FREE_TURNS
		) {
			await this.#core.hooks.error.log.emit({
				store,
				runId,
				turn,
				loopId,
				message: `${state.phaseTurnCount} turns in current stage. Attempt to proceed to next stage.`,
				status: 408,
				attributes: { stagnation: true, phase: newPhase },
			});
		}

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
			return {
				continue: true,
				reason: CONTRACT_REMINDER,
			};
		}

		state.streak = 0;
		return { continue: true };
	}
}
