export default class ErrorLog {
	constructor(core) {
		core.registerScheme({ category: "logging" });
		// Errors are feedback signals — the demoted projection still
		// shows the body so the model sees what went wrong even when
		// fidelity is demoted.
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
