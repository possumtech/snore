const MAX_STRIKES = Number(process.env.RUMMY_MAX_STRIKES) || 3;
const MIN_CYCLES = Number(process.env.RUMMY_MIN_CYCLES) || 3;
const MAX_CYCLE_PERIOD = Number(process.env.RUMMY_MAX_CYCLE_PERIOD) || 4;

const CONTRACT_REMINDER =
	"Missing update (status = 102 to continue, status = 200 to conclude)";

/**
 * Build a stable fingerprint for a single recorded entry: scheme + all
 * attributes, sorted. No body, no target normalization, no classification.
 * Identical tag+attrs across turns signals repetition regardless of what
 * the tool does.
 */
function fingerprint(entry) {
	const parts = Object.keys(entry.attributes)
		.toSorted()
		.filter((k) => entry.attributes[k] != null)
		.map((k) => `${k}=${entry.attributes[k]}`);
	return `${entry.scheme}:${parts.join(",")}`;
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
 * Three strikes, you're out.
 *
 * A turn strikes if any of:
 *   - the model failed to emit a valid <update/> (strike from update.resolve)
 *   - any action dispatched this turn failed (hasErrors)
 *   - the turn completed a repeating fingerprint cycle
 *
 * Three consecutive strikes → run abandoned with status 499.
 * A valid terminal <update status="200|204|422"> → run complete with 200.
 * Any clean turn in between resets the streak.
 */
export default class ResponseHealer {
	#strikeStreak = 0;
	#turnHistory = [];

	/**
	 * Contract reminder for the model when update was missing or malformed.
	 * Called by update.resolve when the healer needs to stand in for a
	 * missing <update/>. We don't synthesize summary or continuation on
	 * the model's behalf — completion is the model's responsibility.
	 */
	static healStatus() {
		return {
			summaryText: null,
			updateText: null,
			warning: CONTRACT_REMINDER,
		};
	}

	/**
	 * Single assessment per turn. Combines strike tracking and cycle detection.
	 */
	assessTurn({ summaryText, strike, hasErrors, recorded }) {
		if (summaryText && !strike && !hasErrors) {
			this.#strikeStreak = 0;
			return { continue: false, status: 200 };
		}

		let cycleReason = null;
		if (recorded && recorded.length > 0) {
			const fp = recorded.map(fingerprint).toSorted().join("|");
			this.#turnHistory.push(fp);
			const cycle = detectCycle(this.#turnHistory);
			if (cycle.detected) {
				cycleReason = `Cyclic tool pattern (period ${cycle.period}, ${cycle.cycles} repetitions)`;
			}
		}

		const struck = !!strike || !!hasErrors || !!cycleReason;

		if (struck) {
			this.#strikeStreak++;
			if (this.#strikeStreak >= MAX_STRIKES) {
				return {
					continue: false,
					status: 499,
					reason:
						cycleReason ||
						`Abandoned after ${this.#strikeStreak} consecutive strikes.`,
				};
			}
			return {
				continue: true,
				reason: cycleReason || CONTRACT_REMINDER,
			};
		}

		this.#strikeStreak = 0;
		return { continue: true };
	}

	reset() {
		this.#strikeStreak = 0;
		this.#turnHistory = [];
	}
}
