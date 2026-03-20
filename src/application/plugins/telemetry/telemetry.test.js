import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import createHooks from "../../../domain/hooks/Hooks.js";
import DebugLoggerPlugin from "./telemetry.js";

test("DebugLoggerPlugin", async (t) => {
	const auditDir = join(process.cwd(), "test_audits");
	process.env.RUMMY_AUDIT_DIR = auditDir;
	process.env.RUMMY_DEBUG = "true";

	t.after(async () => {
		await fs.rm(auditDir, { recursive: true, force: true });
		delete process.env.RUMMY_AUDIT_DIR;
		delete process.env.RUMMY_DEBUG;
	});

	await t.test("should write audit file on event", async () => {
		const hooks = createHooks();
		DebugLoggerPlugin.register(hooks);

		const mockTurn = {
			doc: { documentElement: { getAttribute: () => "0" } },
			toXml: () => "<turn/>",
		};

		await hooks.run.turn.audit.emit({ runId: "r1", turn: mockTurn });

		const filePath = join(auditDir, "run_r1", "turn_0.xml");
		const content = await fs.readFile(filePath, "utf8");
		assert.strictEqual(content, "<turn/>");
	});
});
