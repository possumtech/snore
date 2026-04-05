import HeuristicMatcher, { generatePatch } from "./matcher.js";

/**
 * Hedberg: the interpretation boundary between stochastic model output
 * and deterministic system operations.
 *
 * Owns all pattern matching, fuzzy matching, sed regex execution,
 * and input normalization. Other plugins call hedberg.replace() and
 * get clean, deterministic results regardless of what syntax the
 * model used.
 */
export default class Hedberg {
	#core;

	constructor(core) {
		this.#core = core;
	}

	/**
	 * Apply a replacement to text. Handles sed regex, literal match,
	 * and heuristic fuzzy match — in that order.
	 *
	 * Returns { patch, searchText, replaceText, warning, error }
	 */
	static replace(body, search, replacement, { sed = false, flags = "" } = {}) {
		let patch = null;
		let warning = null;
		let error = null;
		const searchText = search;
		const replaceText = replacement;

		if (sed) {
			try {
				const re = new RegExp(
					searchText,
					flags.includes("g") ? flags : `${flags}g`,
				);
				patch = body.replace(re, replaceText);
				if (patch === body) patch = null;
			} catch {
				// Invalid regex — fall through to literal/heuristic interpretation
			}
		}

		if (!patch && body.includes(searchText)) {
			patch = body.replaceAll(searchText, replaceText);
		}

		if (!patch) {
			const matched = HeuristicMatcher.matchAndPatch(
				"",
				body,
				searchText,
				replaceText,
			);
			patch = matched.newContent;
			warning = matched.warning;
			error = matched.error;
		}

		return { patch, searchText, replaceText, warning, error };
	}
}

export { generatePatch };
