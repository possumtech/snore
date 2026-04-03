import { storePatternResult } from "../helpers.js";

const BOTH = new Set(["ask", "act"]);

export default class ReadPlugin {
	static register(hooks) {
		hooks.tools.register("read", {
			modes: BOTH,
			category: "ask",
			handler: handleRead,
			project: (entry) => {
				const attrs = entry.attributes || {};
				return `# read ${attrs.path || entry.path}\n${entry.body}`;
			},
		});
	}
}

async function handleRead(entry, rummy) {
	const { entries: store, sequence: turn, runId } = rummy;
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
			matches.length > 0 ? `${paths} ${total} tokens` : `${target} not found`;
		await store.upsert(runId, turn, entry.resultPath, body, "read");
	}
}
