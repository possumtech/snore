import { parseEditContent } from "./edits.js";
import HeuristicMatcher, { generatePatch } from "./matcher.js";
import { normalizeAttrs } from "./normalize.js";
import { hedmatch, hedsearch } from "./patterns.js";
import { parseSed } from "./sed.js";

/**
 * Hedberg: the interpretation boundary between stochastic model output
 * and deterministic system operations.
 *
 * Registers its functions on core.hedberg so any plugin can call them:
 *   core.hedberg.match(pattern, string)
 *   core.hedberg.search(pattern, string)
 *   core.hedberg.replace(body, search, replacement, options?)
 *   core.hedberg.parseSed(input)
 *   core.hedberg.parseEdits(content)
 *   core.hedberg.normalizeAttrs(attrs)
 *   core.hedberg.generatePatch(path, old, new)
 */
export default class Hedberg {
	#core;

	constructor(core) {
		this.#core = core;

		core.hooks.hedberg = {
			match: hedmatch,
			search: hedsearch,
			replace: Hedberg.replace,
			parseSed,
			parseEdits: parseEditContent,
			normalizeAttrs,
			generatePatch,
		};

		// Patterns documentation distributed to individual tool docs.
		// Hedberg has no model-facing docs of its own.
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
