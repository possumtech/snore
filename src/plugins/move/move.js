import KnownStore from "../../agent/KnownStore.js";

const BOTH = new Set(["ask", "act"]);

export default class MovePlugin {
	static register(hooks) {
		hooks.tools.register("move", {
			modes: BOTH,
			category: "act",
			handler: handleMove,
			project: (entry) => {
				const attrs = entry.attributes || {};
				return `# mv ${attrs.from || ""} ${attrs.to || ""}`;
			},
		});
	}
}

async function handleMove(entry, rummy) {
	const { entries: store, sequence: turn, runId } = rummy;
	const attrs = entry.attributes || {};
	if (!attrs.path || !attrs.to) return;

	const source = await store.getBody(runId, attrs.path);
	if (source === null) return;

	const destScheme = KnownStore.scheme(attrs.to);

	const existing = await store.getBody(runId, attrs.to);
	let warning = null;
	if (existing !== null && destScheme !== null) {
		warning = `Overwrote existing entry at ${attrs.to}`;
	}

	const body = `${attrs.path} ${attrs.to}`;
	if (destScheme === null) {
		await store.upsert(runId, turn, entry.resultPath, body, "proposed", {
			attributes: { from: attrs.path, to: attrs.to, isMove: true, warning },
		});
	} else {
		await store.upsert(runId, turn, attrs.to, source, "full");
		await store.remove(runId, attrs.path);
		await store.upsert(runId, turn, entry.resultPath, body, "pass", {
			attributes: { from: attrs.path, to: attrs.to, isMove: true, warning },
		});
	}
}
