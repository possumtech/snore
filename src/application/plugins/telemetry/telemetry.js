import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DebugLoggerPlugin: Writes audit files for every turn.
 */
export default class DebugLoggerPlugin {
	static register(hooks) {
		hooks.run.turn.audit.on(async (payload) => {
			if (process.env.RUMMY_DEBUG !== "true") return;
			await DebugLoggerPlugin.#saveAudit(payload);
		});
	}

	static async #saveAudit({ runId, turn }) {
		const auditBase = process.env.RUMMY_AUDIT_DIR || "audits";
		const runDir = join(auditBase, `run_${runId}`);

		try {
			mkdirSync(runDir, { recursive: true });

			const json = turn.toJson();
			const seq = json.sequence ?? Date.now();
			const fileName = `turn_${seq}.json`;
			const filePath = join(runDir, fileName);

			const content = JSON.stringify(json, null, 2);
			writeFileSync(filePath, content);
			writeFileSync(join(auditBase, "audit_latest.json"), content);

			console.log(`[DEBUG] Audit written: ${filePath}`);
		} catch (err) {
			console.error(`[DEBUG] Failed to write audit: ${err.message}`);
		}
	}
}
