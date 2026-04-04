import KnownStore from "../../agent/KnownStore.js";
import { storePatternResult } from "../helpers.js";
import HeuristicMatcher, { generatePatch } from "./HeuristicMatcher.js";

const BOTH = new Set(["ask", "act"]);

export default class SetPlugin {
	static register(hooks) {
		hooks.tools.register("set", {
			modes: BOTH,
			category: "act",
			handler: handleSet,
			project: (entry) => {
				const attrs = entry.attributes || {};
				const file = attrs.file || entry.path;
				if (attrs.error) return `# set ${file}\n${attrs.error}`;
				const tokens =
					attrs.beforeTokens != null
						? ` ${attrs.beforeTokens}→${attrs.afterTokens} tokens`
						: "";
				if (!attrs.merge) return `# set ${file}${tokens}`;
				return `# set ${file}${tokens}\n${attrs.merge}`;
			},
		});
	}
}

async function handleSet(entry, rummy) {
	const { entries: store, sequence: turn, runId } = rummy;
	const attrs = entry.attributes || {};

	if (attrs.blocks || attrs.search != null) {
		await processEdit(store, runId, turn, entry, attrs);
		return;
	}

	if (attrs.preview && attrs.path) {
		const matches = await store.getEntriesByPattern(
			runId,
			attrs.path,
			attrs.body,
		);
		await storePatternResult(
			store,
			runId,
			turn,
			"set",
			attrs.path,
			attrs.body,
			matches,
			true,
		);
		return;
	}

	const target = attrs.path;
	if (!target) return;

	const scheme = KnownStore.scheme(target);
	if (scheme === null) {
		const udiff = generatePatch(target, "", entry.body || "");
		const merge = `<<<<<<< SEARCH\n=======\n${entry.body || ""}\n>>>>>>> REPLACE`;
		// body = empty (new file, no original). attributes carry patch + merge.
		await store.upsert(runId, turn, entry.resultPath, "", "proposed", {
			attributes: { file: target, patch: udiff, merge },
		});
	} else if (attrs.filter || target.includes("*")) {
		const matches = await store.getEntriesByPattern(
			runId,
			target,
			attrs.filter,
		);
		await store.updateBodyByPattern(
			runId,
			target,
			attrs.filter || null,
			entry.body,
		);
		await storePatternResult(
			store,
			runId,
			turn,
			"set",
			target,
			attrs.filter,
			matches,
		);
	} else {
		await store.upsert(runId, turn, target, entry.body, "full");
	}
}

async function processEdit(store, runId, turn, entry, attrs) {
	const target = attrs.path;
	const matches = await store.getEntriesByPattern(runId, target, attrs.body);

	if (matches.length === 0) {
		await store.upsert(runId, turn, entry.resultPath, "", "error", {
			attributes: { file: target, error: `${target} not found in context` },
		});
		return;
	}

	for (const match of matches) {
		const resultPath = `set://${match.path}`;
		// Current file content — may already have earlier edits from this turn
		const currentBody = match.body;
		let patch = null;
		let warning = null;
		let error = null;
		let searchText = null;
		let replaceText = null;

		if (attrs.search != null) {
			searchText = attrs.search;
			replaceText = attrs.replace ?? "";
			if (currentBody.includes(attrs.search)) {
				patch = currentBody.replaceAll(attrs.search, replaceText);
			} else {
				const matched = HeuristicMatcher.matchAndPatch(
					match.path,
					currentBody,
					attrs.search,
					replaceText,
				);
				patch = matched.newContent;
				warning = matched.warning;
				error = matched.error;
			}
		} else if (attrs.blocks?.length > 0 && attrs.blocks[0].search === null) {
			patch = attrs.blocks[0].replace;
			replaceText = attrs.blocks[0].replace;
		} else if (currentBody && attrs.blocks?.length > 0) {
			const block = attrs.blocks[0];
			searchText = block.search;
			replaceText = block.replace;
			const matched = HeuristicMatcher.matchAndPatch(
				match.path,
				currentBody,
				block.search,
				block.replace,
			);
			patch = matched.newContent;
			warning = matched.warning;
			error = matched.error;
		}

		const state = error ? "error" : match.scheme === null ? "proposed" : "pass";

		// Check for existing result from earlier edit this turn
		const existing = await store.getEntry(resultPath);
		const originalBody = existing?.body || currentBody;

		// Patch and merge are always against the ORIGINAL content
		const udiff = patch ? generatePatch(match.path, originalBody, patch) : null;

		// Accumulate merge blocks from prior edits
		const priorMerge = existing?.attributes?.merge || "";
		const thisMerge =
			searchText != null
				? `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`
				: "";
		const merge = [priorMerge, thisMerge].filter(Boolean).join("\n") || null;

		const beforeTokens = existing?.attributes?.beforeTokens ?? match.tokens_full ?? 0;
		const afterTokens = patch ? (patch.length / 4) | 0 : beforeTokens;

		// body = original content (before any edits this turn)
		await store.upsert(runId, turn, resultPath, originalBody, state, {
			attributes: {
				file: match.path,
				patch: udiff,
				merge,
				beforeTokens,
				afterTokens,
				warning,
				error,
			},
		});

		if (state === "pass" && patch) {
			await store.upsert(runId, turn, match.path, patch, match.state);
		}

		// If this entry merged into an existing result, demote the recorded entry to audit
		if (entry.resultPath !== resultPath) {
			await store.upsert(runId, turn, entry.resultPath, entry.body, "info", {
				attributes: { mergedInto: resultPath },
			});
		}
	}
}
