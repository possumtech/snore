import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default class DebugLoggerPlugin {
	static register(hooks) {
		hooks.run.step.completed.on(async (payload) => {
			if (process.env.RUMMY_DEBUG !== "true") return;

			const auditBase = process.env.RUMMY_AUDIT_DIR || "audits";
			const runDir = join(auditBase, `run_${payload.run}`);

			try {
				mkdirSync(runDir, { recursive: true });

				const fileName = `turn_${payload.turn ?? Date.now()}.json`;
				const filePath = join(runDir, fileName);
				const content = JSON.stringify(payload, null, 2);

				writeFileSync(filePath, content);
				writeFileSync(join(auditBase, "audit_latest.json"), content);
			} catch (err) {
				console.error(`[DEBUG] Failed to write audit: ${err.message}`);
			}
		});
	}
}
