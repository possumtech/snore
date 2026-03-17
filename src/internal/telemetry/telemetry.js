import { writeFileSync } from "node:fs";

/**
 * DebugLoggerPlugin: Writes clean XML audits.
 */
export default class DebugLoggerPlugin {
	static register(hooks) {
		hooks.ask.completed.on(async ({ turn }) => {
			if (process.env.RUMMY_DEBUG !== "true") return;

			const auditFile = process.env.RUMMY_AUDIT_FILE || "audit_last_turn.xml";
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
