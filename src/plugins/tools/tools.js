import HeuristicMatcher from "../../agent/HeuristicMatcher.js";
import KnownStore from "../../agent/KnownStore.js";

const BOTH = new Set(["ask", "act"]);
const ACT_ONLY = new Set(["act"]);

export default class CoreToolsPlugin {
	static register(hooks) {
		const { tools } = hooks;

		// Structural — no handler (recording IS the action)
		tools.register("summarize", { modes: BOTH, category: "structural" });
		tools.register("update", { modes: BOTH, category: "structural" });
		tools.register("unknown", { modes: BOTH, category: "structural" });

		// Investigation
		tools.register("read", {
			modes: BOTH,
			category: "ask",
			handler: handleRead,
		});
		tools.register("store", {
			modes: BOTH,
			category: "ask",
			handler: handleStore,
		});
		tools.register("env", {
			modes: BOTH,
			category: "ask",
			handler: handleEnv,
		});

		// Mutation
		tools.register("write", {
			modes: BOTH,
			category: "act",
			handler: handleWrite,
		});
		tools.register("move", {
			modes: BOTH,
			category: "act",
			handler: handleMoveCopy,
		});
		tools.register("copy", {
			modes: BOTH,
			category: "act",
			handler: handleMoveCopy,
		});
		tools.register("delete", {
			modes: BOTH,
			category: "act",
			handler: handleDelete,
		});
		tools.register("run", {
			modes: ACT_ONLY,
			category: "act",
			handler: handleRun,
		});
		tools.register("ask_user", {
			modes: BOTH,
			category: "act",
			handler: handleAskUser,
		});
	}
}

// --- Handlers ---
// Each handler receives (entry, rummy) where entry is the recorded row:
//   { path, scheme, body, attributes, state, resultPath }
// The handler performs side effects and updates the entry via rummy.store.

async function handleRead(entry, rummy) {
	const { store, sequence: turn, runId } = rummy;
	const attrs = entry.attributes || {};
	const target = attrs.path;
	if (!target) return;

	const bodyFilter = attrs.body || null;
	const isPattern = bodyFilter || target.includes("*");
	const matches = await store.getEntriesByPattern(runId, target, bodyFilter);
	await store.promoteByPattern(runId, target, bodyFilter, turn);

	if (isPattern) {
		await storePatternResult(
			store,
			runId,
			turn,
			"read",
			target,
			bodyFilter,
			matches,
		);
	} else {
		const total = matches.reduce((s, m) => s + m.tokens_full, 0);
		const paths = matches.map((m) => m.path).join(", ");
		const body =
			matches.length > 0
				? `${paths} loaded in context (${total} tokens)`
				: `${target} not found`;
		await store.upsert(runId, turn, entry.resultPath, body, "read");
	}
}

async function handleStore(entry, rummy) {
	const { store, sequence: turn, runId } = rummy;
	const attrs = entry.attributes || {};
	const target = attrs.path;
	if (!target) return;

	const bodyFilter = attrs.body || null;
	const isPattern = bodyFilter || target.includes("*");
	const matches = await store.getEntriesByPattern(runId, target, bodyFilter);
	await store.demoteByPattern(runId, target, bodyFilter);

	if (isPattern) {
		await storePatternResult(
			store,
			runId,
			turn,
			"store",
			target,
			bodyFilter,
			matches,
		);
	} else {
		const paths = matches.map((m) => m.path).join(", ");
		const body =
			matches.length > 0
				? `${paths} removed from context. Use <read> to restore.`
				: `${target} not found`;
		await store.upsert(runId, turn, entry.resultPath, body, "stored");
	}
}

async function handleWrite(entry, rummy) {
	const { store, sequence: turn, runId } = rummy;
	const attrs = entry.attributes || {};

	// Edit mode: blocks or search/replace
	if (attrs.blocks || attrs.search != null) {
		await processEdit(store, runId, turn, entry, attrs);
		return;
	}

	// Preview mode
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
	if (!target) {
		// Naked write — already recorded as known:// by recorder
		return;
	}

	const scheme = KnownStore.scheme(target);
	if (scheme === null) {
		// File write → proposed for client review
		const tokenEst = ((entry.body?.length || 0) / 4) | 0;
		await store.upsert(
			runId,
			turn,
			entry.resultPath,
			`${target} (new file, ${tokenEst} tokens)`,
			"proposed",
			{ attributes: { file: target, content: entry.body } },
		);
	} else if (attrs.filter || target.includes("*")) {
		// Pattern bulk update
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
		// Literal K/V path → immediate upsert
		await store.upsert(runId, turn, target, entry.body, "full");
	}
}

async function processEdit(store, runId, turn, entry, attrs) {
	const target = attrs.path;
	const matches = await store.getEntriesByPattern(runId, target, attrs.body);

	if (matches.length === 0) {
		await store.upsert(
			runId,
			turn,
			entry.resultPath,
			`${target} — not found in context. Use <read> to load it first.`,
			"error",
			{ attributes: { file: target, error: "not found" } },
		);
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
			const isRegex = /[+(){}|\\$^*?[\]]/.test(attrs.search);
			if (isRegex) {
				const re = new RegExp(attrs.search, "g");
				if (re.test(match.body)) {
					patch = match.body.replace(re, replaceText);
				} else {
					error = `Search pattern not found in ${match.path}`;
				}
			} else if (match.body.includes(attrs.search)) {
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

		const beforeTokens = match.tokens_full || 0;
		const afterTokens = patch ? (patch.length / 4) | 0 : beforeTokens;
		let body;
		if (error) {
			const block = searchText
				? `\n<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`
				: "";
			body = `${match.path} — ${error}${block}`;
		} else if (searchText) {
			body = `${match.path} (${beforeTokens} → ${afterTokens} tokens)\n<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`;
		} else {
			body = `${match.path} (${beforeTokens} → ${afterTokens} tokens)`;
		}

		await store.upsert(runId, turn, resultPath, body, state, {
			attributes: {
				file: match.path,
				search: attrs.search,
				replace: attrs.replace,
				blocks: attrs.blocks,
				patch,
				warning,
				error,
			},
		});

		if (state === "pass" && patch) {
			await store.upsert(runId, turn, match.path, patch, match.state);
		}
	}
}

async function handleDelete(entry, rummy) {
	const { store, sequence: turn, runId } = rummy;
	const attrs = entry.attributes || {};
	const target = attrs.path;
	if (!target) return;

	const matches = await store.getEntriesByPattern(runId, target, attrs.body);

	for (const match of matches) {
		const resultPath = `delete://${match.path}`;
		const body = `rm ${match.path}`;
		if (match.scheme === null) {
			await store.upsert(runId, turn, resultPath, body, "proposed", {
				attributes: { path: match.path },
			});
		} else {
			await store.remove(runId, match.path);
			await store.upsert(runId, turn, resultPath, body, "pass", {
				attributes: { path: match.path },
			});
		}
	}
}

async function handleMoveCopy(entry, rummy) {
	const { store, sequence: turn, runId } = rummy;
	const attrs = entry.attributes || {};
	if (!attrs.path || !attrs.to) return;

	const source = await store.getBody(runId, attrs.path);
	if (source === null) return;

	const destScheme = KnownStore.scheme(attrs.to);
	const isMove = entry.scheme === "move";

	const existing = await store.getBody(runId, attrs.to);
	let warning = null;
	if (existing !== null && destScheme !== null) {
		warning = `Overwrote existing entry at ${attrs.to}`;
	}

	const verb = isMove ? "mv" : "cp";
	const body = `${verb} ${attrs.path} ${attrs.to}`;
	if (destScheme === null) {
		await store.upsert(runId, turn, entry.resultPath, body, "proposed", {
			attributes: { from: attrs.path, to: attrs.to, isMove, warning },
		});
	} else {
		await store.upsert(runId, turn, attrs.to, source, "full");
		if (isMove) {
			await store.remove(runId, attrs.path);
		}
		await store.upsert(runId, turn, entry.resultPath, body, "pass", {
			attributes: { from: attrs.path, to: attrs.to, isMove, warning },
		});
	}
}

async function handleRun(entry, rummy) {
	const { store, sequence: turn, runId } = rummy;
	// run → proposed for client resolution
	await store.upsert(runId, turn, entry.resultPath, entry.body, "proposed", {
		attributes: entry.attributes,
	});
}

async function handleEnv(entry, rummy) {
	const { store, sequence: turn, runId } = rummy;
	// env → pass (client provides output via resolve)
	await store.upsert(runId, turn, entry.resultPath, entry.body, "pass", {
		attributes: entry.attributes,
	});
}

async function handleAskUser(entry, rummy) {
	const { store, sequence: turn, runId } = rummy;
	// ask_user → proposed for client resolution
	await store.upsert(runId, turn, entry.resultPath, entry.body, "proposed", {
		attributes: entry.attributes,
	});
}

// --- Shared helpers ---

async function storePatternResult(
	store,
	runId,
	turn,
	scheme,
	path,
	bodyFilter,
	matches,
	preview = false,
) {
	const slug = await store.slugPath(runId, scheme, path);
	const filter = bodyFilter ? ` body="${bodyFilter}"` : "";
	const total = matches.reduce((s, m) => s + m.tokens_full, 0);
	const listing = matches.map((m) => `${m.path} (${m.tokens_full})`).join("\n");
	const prefix = preview ? "PREVIEW " : "";
	const body = `${prefix}${scheme} path="${path}"${filter}: ${matches.length} matched (${total} tokens)\n${listing}`;
	await store.upsert(runId, turn, slug, body, "pattern");
}
