const ACT_ONLY = new Set(["act"]);

export default class RunPlugin {
	static register(hooks) {
		hooks.tools.register("run", {
			modes: ACT_ONLY,
			category: "act",
			handler: handleRun,
			project: (entry) => {
				const attrs = entry.attributes || {};
				return `# sh ${attrs.command || ""}\n${entry.body}`;
			},
		});
	}
}

async function handleRun(entry, rummy) {
	const { entries: store, sequence: turn, runId } = rummy;
	await store.upsert(runId, turn, entry.resultPath, entry.body, "proposed", {
		attributes: entry.attributes,
	});
}
