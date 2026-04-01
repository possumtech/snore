const MAX_STALLS = Number(process.env.RUMMY_MAX_STALLS) || 3;
const MAX_REPETITIONS = Number(process.env.RUMMY_MAX_REPETITIONS) || 3;

export default class ResponseHealer {
	#stallCount = 0;
	#lastFingerprint = null;
	#repetitionCount = 0;

	/**
	 * Heal a missing status tag. Called when the model emits
	 * neither <summary/> nor <update/>.
	 */
	static healUpdate(content, commands) {
		const trimmed = content.trim();

		if (commands.length === 0 && trimmed) {
			console.warn("[RUMMY] Healed: plain text response used as update");
			return trimmed.slice(0, 500);
		}

		console.warn(
			`[RUMMY] Healed: missing <update>/<summary>. Tools: ${commands.map((c) => c.name).join(", ") || "none"}`,
		);
		return "...";
	}

	/**
	 * Check for repeated tool commands across turns.
	 * Returns { continue: boolean, reason?: string }
	 *
	 * Fingerprints the commands (name + path/query). If the same fingerprint
	 * repeats for MAX_REPETITIONS consecutive turns, force-complete.
	 */
	assessRepetition({ actionCalls, writeCalls }) {
		const commands = [...(actionCalls || []), ...(writeCalls || [])];
		if (commands.length === 0) {
			this.#lastFingerprint = null;
			this.#repetitionCount = 0;
			return { continue: true };
		}

		const fingerprint = commands
			.map((c) => `${c.name}:${c.path || c.command || c.question || ""}`)
			.toSorted()
			.join("|");

		if (fingerprint === this.#lastFingerprint) {
			this.#repetitionCount++;
			if (this.#repetitionCount >= MAX_REPETITIONS) {
				const reason = `Same commands repeated ${this.#repetitionCount} turns`;
				console.warn(`[RUMMY] Loop detected: ${reason}. Force-completing.`);
				return { continue: false, reason };
			}
			console.warn(
				`[RUMMY] Repeated commands (${this.#repetitionCount}/${MAX_REPETITIONS}): ${fingerprint.slice(0, 80)}`,
			);
		} else {
			this.#repetitionCount = 1;
			this.#lastFingerprint = fingerprint;
		}

		return { continue: true };
	}

	/**
	 * Assess whether the run should continue.
	 *
	 * Returns { continue: boolean, reason?: string }
	 *
	 * Rules:
	 *   <summary/> present → done (terminate)
	 *   <update/> present  → continue (model says it's working)
	 *   neither present    → warn, increment stall counter, continue
	 *   stall counter hits MAX_STALLS → force-complete
	 */
	assessProgress({ summaryText, updateText, statusHealed }) {
		if (summaryText) {
			this.#stallCount = 0;
			return { continue: false };
		}

		if (updateText && !statusHealed) {
			this.#stallCount = 0;
			return { continue: true };
		}

		// Healed or neither — model is glitching
		this.#stallCount++;

		if (this.#stallCount >= MAX_STALLS) {
			const reason = `${this.#stallCount} turns with no <update/> or <summary/>`;
			console.warn(`[RUMMY] Stalled: ${reason}. Force-completing.`);
			return { continue: false, reason };
		}

		console.warn(
			`[RUMMY] No <update/> or <summary/> (stall ${this.#stallCount}/${MAX_STALLS})`,
		);
		return { continue: true };
	}

	/**
	 * Reset state for a new run or after resolution resume.
	 */
	reset() {
		this.#stallCount = 0;
		this.#lastFingerprint = null;
		this.#repetitionCount = 0;
	}
}
