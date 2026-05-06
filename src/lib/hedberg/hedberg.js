import { parseEditContent } from "./edits.js";
import HeuristicMatcher, { generatePatch } from "./matcher.js";
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
			generatePatch,
		};
	}

	// Order: literal substitution → heuristic fuzzy.
	//
	// sed=true semantically means "literal substring substitution with
	// regex-style escape friendliness." The model writes `\[`, `\.`,
	// `\|`, etc. out of muscle memory from real sed, but we don't
	// compile a regex — native String.replaceAll does the substitution.
	// We strip the regex-meta backslashes from search and replacement
	// so the model's escaped chars match their literal counterparts in
	// body. This sidesteps a class of "regex-meta in content" failures
	// and the parser-edge-case surface that compiling user input as
	// regex drags in.
	static replace(body, search, replacement, { sed = false } = {}) {
		let patch = null;
		let warning = null;
		let error = null;
		const stripRegexEscapes = (s) => s.replace(/\\([[\](){}.*+?^$|\\])/g, "$1");
		const searchText = sed ? stripRegexEscapes(search) : search;
		const replaceText = sed ? stripRegexEscapes(replacement) : replacement;

		if (body.includes(searchText)) {
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
