import KnownStore from "../../agent/KnownStore.js";
import { storePatternResult } from "../helpers.js";
import HeuristicMatcher, { generatePatch } from "./HeuristicMatcher.js";

const BOTH = new Set(["ask", "act"]);

export default class WritePlugin {
	static register(hooks) {
		hooks.tools.register("write", {
			modes: BOTH,
			category: "act",
			handler: handleWrite,
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

async function handleWrite(entry, rummy) {
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
			"write",
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
		const merge = `=======\n${entry.body || ""}\n>>>>>>> REPLACE`;
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
			"write",
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
		const resultPath = `write://${match.path}`;
		let patch = null;
		let warning = null;
		let error = null;
		let searchText = null;
		let replaceText = null;

		if (attrs.search != null) {
			searchText = attrs.search;
			replaceText = attrs.replace ?? "";
			if (match.body.includes(attrs.search)) {
				patch = match.body.replaceAll(attrs.search, replaceText);
			} else {
				error = `"${attrs.search}" not found in ${match.path}`;
			}
		} else if (attrs.blocks?.length > 0 && attrs.blocks[0].search === null) {
			patch = attrs.blocks[0].replace;
			replaceText = attrs.blocks[0].replace;
		} else if (match.body && attrs.blocks?.length > 0) {
			const block = attrs.blocks[0];
			searchText = block.search;
			replaceText = block.replace;
			const matched = HeuristicMatcher.matchAndPatch(
				match.path,
				match.body,
				block.search,
				block.replace,
			);
			patch = matched.patch;
			warning = matched.warning;
			error = matched.error;
		}

		const state = error ? "error" : match.scheme === null ? "proposed" : "pass";

		const udiff = patch ? generatePatch(match.path, match.body, patch) : null;
		const merge =
			searchText != null
				? `<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`
				: null;

		// body = original content (reconstructable with patch)
		// attributes.patch = udiff for client
		// attributes.merge = git conflict for model projection
		const beforeTokens = match.tokens_full || 0;
		const afterTokens = patch ? (patch.length / 4) | 0 : beforeTokens;

		await store.upsert(runId, turn, resultPath, match.body, state, {
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
	}
}
