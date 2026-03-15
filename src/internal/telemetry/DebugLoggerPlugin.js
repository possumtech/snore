import { writeFileSync } from "node:fs";

export default class DebugLoggerPlugin {
	static register(hooks) {
		// Event Logging
		hooks.addAction(
			"project_initialized",
			async ({ projectId, projectPath }) => {
				console.log(
					`[EVENT] Project Initialized: ${projectId} at ${projectPath}`,
				);
			},
		);

		hooks.addAction("job_started", async ({ jobId, type }) => {
			console.log(`[EVENT] Job Started: ${jobId} (Type: ${type})`);
		});

		// CLEAN XML AUDIT: Write the full <turn> document to a file
		hooks.addAction("ask_completed", async ({ turn }) => {
			if (process.env.SNORE_DEBUG !== "true") return;

			const auditFile = "audit_last_turn.xml";
			try {
				const xml = turn.toXml();
				writeFileSync(auditFile, xml);
				console.log(`[DEBUG] Audit XML written to: ${auditFile}`);
			} catch (err) {
				console.error(`[DEBUG] Failed to write audit XML: ${err.message}`);
			}
		});
	}
}
