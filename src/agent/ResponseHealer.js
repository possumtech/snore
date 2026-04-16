const MAX_STALLS = Number(process.env.RUMMY_MAX_STALLS) || 3;
const MIN_CYCLES = Number(process.env.RUMMY_MIN_CYCLES) || 3;
const MAX_CYCLE_PERIOD = Number(process.env.RUMMY_MAX_CYCLE_PERIOD) || 4;
const MAX_UPDATE_REPEATS = Number(process.env.RUMMY_MAX_UPDATE_REPEATS) || 3;
const MAX_PATH_STAGNATION = Number(process.env.RUMMY_MAX_PATH_STAGNATION) || 5;

/**
 * Build a stable fingerprint for a single recorded entry.
 * Uses scheme + original command target + all op-defining attributes.
 * Excludes body (content too granular; same operation ≠ same content).
 */
function cmdFingerprint(entry) {
	const attrs = { ...(entry.attributes ?? {}) };
	delete attrs.body;
	const target =
		attrs.path ?? attrs.command ?? attrs.query ?? attrs.question ?? "";
	delete attrs.path;
	const extra = Object.keys(attrs)
		.toSorted()
		.filter((k) => attrs[k] != null)
		.map((k) => `${k}=${attrs[k]}`)
		.join(",");
	return `${entry.scheme}:${target}${extra ? `[${extra}]` : ""}`;
}

/**
 * Detect a repeating cycle in the fingerprint history.
 * Checks periods 1..MAX_CYCLE_PERIOD for MIN_CYCLES consecutive repetitions.
 * Catches AAAA (period 1), ABABAB (period 2), ABCABCABC (period 3), etc.
 */
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

/**
 * Extract the target paths a command touches for stagnation detection.
 * Same target logic as cmdFingerprint but returns the raw path for set
 * comparison across turns.
 */
function cmdPaths(entry) {
	const attrs = entry.attributes ?? {};
	const paths = [];
	if (attrs.path) paths.push(attrs.path);
	if (attrs.to) paths.push(attrs.to);
	if (attrs.command) paths.push(attrs.command);
	if (attrs.query) paths.push(attrs.query);
	if (attrs.question) paths.push(attrs.question);
	return paths;
}

export default class ResponseHealer {
	#stallCount = 0;
	#turnHistory = [];
	#lastUpdateText = null;
	#updateRepeatCount = 0;
	#pathRuns = new Map(); // path → consecutive turns touched

	/**
	 * Heal a missing status tag. Called when the model emits
	 * neither <summarize/> nor <update/>.
	 */
	/**
	 * Heal a missing status tag. Called when the model emits
	 * neither <summarize/> nor <update/>.
	 *
	 * Plain text with no commands = the model answered. Treat as summary.
	 * Commands with no status tag = the model is working. Treat as update.
	 */
	static healStatus(content, commands) {
		const trimmed = content.trim();

		// Detect malformed-glitch content — model attempted a tool invocation
		// (native call, malformed XML, etc.) that the parser couldn't dispatch.
		// This is NOT an answer; it's a glitch that deserves the 3-strikes
		// stall path so the model can recover. Without this check, the model
		// emits one malformed call and the run terminates after a single turn.
		const looksGlitched = /<\|tool_call>|<tool_call\|>/.test(trimmed);

		// No commands + plain text = answered. Treat as summary.
		if (commands.length === 0 && trimmed && !looksGlitched) {
			console.warn("[RUMMY] Healed: plain text response treated as summary");
			return { summaryText: trimmed.slice(0, 500), updateText: null };
		}

		// Only write/unknown commands + no investigation tools = completed action.
		// The model did the thing without saying <summarize>. Treat as summary.
		const hasInvestigation = commands.some((c) =>
			["get", "env", "search", "ask_user"].includes(c.name),
		);
		if (!hasInvestigation && commands.length > 0) {
			const names = commands.map((c) => c.name).join(", ");
			console.warn(
				`[RUMMY] Healed: action-only response (${names}) treated as summary`,
			);
			return {
				summaryText: trimmed.slice(0, 500) || "Done.",
				updateText: null,
			};
		}

		console.warn(
			`[RUMMY] Healed: missing <update>/<summarize>. Tools: ${commands.map((c) => c.name).join(", ") || "none"}`,
		);
		return { summaryText: null, updateText: "..." };
	}

	/**
	 * Detect cyclic tool patterns across turns.
	 * Returns { continue: boolean, reason?: string }
	 *
	 * Appends this turn's fingerprint to history, then checks whether the
	 * history ends in a repeating cycle of period 1..MAX_CYCLE_PERIOD with
	 * at least MIN_CYCLES consecutive repetitions.
	 *
	 * Catches AAAA (period 1), ABABAB (period 2), ABCABC (period 3), etc.
	 * Turns with no tool calls are skipped — they don't contribute to a cycle.
	 */
	assessRepetition({ actionCalls, writeCalls }) {
		const commands = [...(actionCalls || []), ...(writeCalls || [])];
		if (commands.length === 0) return { continue: true };

		const fp = commands.map(cmdFingerprint).toSorted().join("|");
		this.#turnHistory.push(fp);

		const cycle = detectCycle(this.#turnHistory);
		if (cycle.detected) {
			const reason = `Cyclic tool pattern (period ${cycle.period}, ${cycle.cycles} repetitions)`;
			console.warn(`[RUMMY] Loop detected: ${reason}. Force-completing.`);
			return { continue: false, reason };
		}

		// Distinct-paths stagnation: the model might vary commands turn-to-turn
		// (avoiding exact-cycle detection) but still churn on a single path.
		// Track per-path consecutive touches; flag if any path is touched in
		// MAX_PATH_STAGNATION consecutive turns. Catches semantic stagnation
		// where the fingerprints differ in micro-detail but the work is stuck
		// on one entry (e.g. endlessly re-setting/re-getting the same plan).
		const touchedPaths = new Set();
		for (const cmd of commands) {
			for (const p of cmdPaths(cmd)) touchedPaths.add(p);
		}
		// Paths not touched this turn — run broken, remove from map.
		for (const path of [...this.#pathRuns.keys()]) {
			if (!touchedPaths.has(path)) this.#pathRuns.delete(path);
		}
		// Paths touched this turn — increment run.
		for (const path of touchedPaths) {
			this.#pathRuns.set(path, (this.#pathRuns.get(path) || 0) + 1);
		}
		for (const [path, run] of this.#pathRuns) {
			if (run >= MAX_PATH_STAGNATION) {
				const reason = `Path stagnation: ${path} touched ${run} consecutive turns`;
				console.warn(`[RUMMY] ${reason}. Force-completing.`);
				return { continue: false, reason };
			}
		}

		return { continue: true };
	}

	/**
	 * Assess whether the run should continue.
	 *
	 * Returns { continue: boolean, reason?: string }
	 *
	 * Rules:
	 *   <summarize/> present → done (terminate)
	 *   <summarize/> + failed actions → overridden to <update> (continue)
	 *   <update/> present  → continue (model says it's working)
	 *   neither present    → warn, increment stall counter, continue
	 *   stall counter hits MAX_STALLS → force-complete
	 */
	assessProgress({ summaryText, updateText, statusHealed, flags }) {
		if (summaryText) {
			this.#stallCount = 0;
			return { continue: false };
		}

		if (updateText && !statusHealed) {
			this.#stallCount = 0;
			// Track repeated update text — model stuck declaring readiness
			// But if the model created new entries this turn, it's making
			// progress even if the update text is the same.
			const madeProgress = flags?.hasWrites || flags?.hasReads;
			if (updateText === this.#lastUpdateText && !madeProgress) {
				this.#updateRepeatCount++;
				if (this.#updateRepeatCount >= MAX_UPDATE_REPEATS) {
					const reason = `Same <update/> repeated ${this.#updateRepeatCount} turns: "${updateText.slice(0, 60)}"`;
					console.warn(`[RUMMY] Stalled: ${reason}. Force-completing.`);
					return { continue: false, reason };
				}
			} else {
				this.#lastUpdateText = updateText;
				this.#updateRepeatCount = 1;
			}
			return { continue: true };
		}

		// Healed or neither — model is glitching
		this.#stallCount++;

		if (this.#stallCount >= MAX_STALLS) {
			const reason = `${this.#stallCount} turns with no <update/> or <summarize/>`;
			console.warn(`[RUMMY] Stalled: ${reason}. Force-completing.`);
			return { continue: false, reason };
		}

		console.warn(
			`[RUMMY] No <update/> or <summarize/> (stall ${this.#stallCount}/${MAX_STALLS})`,
		);
		return { continue: true };
	}

	/**
	 * Reset state for a new run or after resolution resume.
	 */
	reset() {
		this.#stallCount = 0;
		this.#turnHistory = [];
		this.#lastUpdateText = null;
		this.#updateRepeatCount = 0;
		this.#pathRuns = new Map();
	}
}
