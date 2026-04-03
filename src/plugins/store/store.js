import { storePatternResult } from "../helpers.js";

const BOTH = new Set(["ask", "act"]);

export default class StorePlugin {
	static register(hooks) {
		hooks.tools.register("store", {
			modes: BOTH,
			category: "ask",
			handler: handleStore,
			project: (entry) => {
				const attrs = entry.attributes || {};
				return `# store ${attrs.path || entry.path}`;
			},
		});
	}
}

async function handleStore(entry, rummy) {
	const { entries: store, sequence: turn, runId } = rummy;
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
		const body = matches.length > 0 ? `${paths} stored` : `${target} not found`;
		await store.upsert(runId, turn, entry.resultPath, body, "stored");
	}
}
