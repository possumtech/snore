export default class ErrorLog {
	constructor(core) {
		core.registerScheme({ category: "logging" });
		core.on("promoted", (entry) => `# error\n${entry.body}`);
		core.on("demoted", (entry) => entry.body);

		core.hooks.error.log.on(async ({ store, runId, turn, message, loopId }) => {
			const path = await store.dedup(runId, "error", message, turn);
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
