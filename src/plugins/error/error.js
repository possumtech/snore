export default class ErrorLog {
	constructor(core) {
		core.registerScheme({ category: "logging" });
		core.on("visible", (entry) => `# error\n${entry.body}`);
		core.on("summarized", (entry) => entry.body);

		core.hooks.error.log.on(async ({ store, runId, turn, message, loopId }) => {
			const path = await store.logPath(runId, turn, "error", message);
			await store.set({
				runId,
				turn,
				path,
				body: message,
				state: "failed",
				outcome: "validation",
				loopId,
			});
		});
	}
}
