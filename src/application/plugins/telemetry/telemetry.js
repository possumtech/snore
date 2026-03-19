import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DebugLoggerPlugin: Writes comprehensive XML audits for every turn.
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

			// Get the current turn count from the context to name the file
			const seq =
				turn.doc.documentElement.getAttribute("sequence") || Date.now();
			const fileName = `turn_${seq}.xml`;
			const filePath = join(runDir, fileName);

			const xml = turn.toXml();
			writeFileSync(filePath, xml);

			// Also maintain a symlink or "latest" file for convenience
			writeFileSync(join(auditBase, "audit_latest.xml"), xml);

			console.log(`[DEBUG] Audit written: ${filePath}`);
		} catch (err) {
			console.error(`[DEBUG] Failed to write audit XML: ${err.message}`);
		}
	}
}
