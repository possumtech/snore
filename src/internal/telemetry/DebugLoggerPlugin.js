import { writeFileSync } from "node:fs";

export default class DebugLoggerPlugin {
	static register(hooks) {
		hooks.addEvent("project_init_started", async ({ projectPath }) => {
			console.log(`[EVENT] Project Init Started: ${projectPath}`);
		});

		hooks.addEvent(
			"project_init_completed",
			async ({ projectId, projectPath }) => {
				console.log(
					`[EVENT] Project Init Completed: ${projectId} at ${projectPath}`,
				);
			},
		);

		hooks.addEvent("job_started", async ({ jobId, type }) => {
			console.log(`[EVENT] Job Started: ${jobId} (Type: ${type})`);
		});

		hooks.addEvent("ask_started", async ({ sessionId, model }) => {
			console.log(
				`[EVENT] Ask Started: Session ${sessionId} (Model: ${model})`,
			);
		});

		// CLEAN XML AUDIT: Write the full <turn> document to a file
		hooks.addEvent("ask_completed", async ({ turn }) => {
			if (process.env.SNORE_DEBUG !== "true") return;

			const auditFile = process.env.SNORE_AUDIT_FILE || "audit_last_turn.xml";
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
