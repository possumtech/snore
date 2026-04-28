import { parseEditContent } from "./edits.js";
import HeuristicMatcher, { generatePatch } from "./matcher.js";
import { parseJsonEdit } from "./normalize.js";
import { hedmatch, hedsearch } from "./patterns.js";
import { parseSed } from "./sed.js";

// Stochastic→deterministic boundary; exposes pattern/edit utilities on core.hedberg. SPEC #hedberg.
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
			parseJsonEdit,
			generatePatch,
		};
	}

	// Order: sed regex → literal → heuristic fuzzy.
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
				// Strip regex-meta escapes in replacement; String.replace only interprets `$`, not `\`.
				const unescaped = replaceText.replace(/\\([[\](){}.*+?^$|\\])/g, "$1");
				patch = body.replace(re, unescaped);
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
