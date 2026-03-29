/**
 * DebugLoggerPlugin: Logs turn data to console when RUMMY_DEBUG=true.
 * Audit data lives in known_entries (/:system/*, /:user/*, /:reasoning/*).
 */
export default class DebugLoggerPlugin {
	static register(hooks) {
		hooks.run.step.completed.on(async (payload) => {
			if (process.env.RUMMY_DEBUG !== "true") return;
			console.log(`[DEBUG] Turn ${payload.turn} completed for run ${payload.run}`);
		});
	}
}
