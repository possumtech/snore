import assert from "node:assert";
import fs from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import createHooks from "../../core/Hooks.js";
import Turn from "../../core/Turn.js";
import DebugLoggerPlugin from "./telemetry.js";

describe("DebugLoggerPlugin", () => {
	const auditFile = "test_audit.xml";

	before(() => {
		process.env.RUMMY_DEBUG = "true";
		process.env.RUMMY_AUDIT_FILE = auditFile;
	});

	after(async () => {
		delete process.env.RUMMY_DEBUG;
		delete process.env.RUMMY_AUDIT_FILE;
		await fs.unlink(auditFile).catch(() => {});
	});

	it("should write audit file on ask_completed", async () => {
		const hooks = createHooks();
		DebugLoggerPlugin.register(hooks);

		const dom = new DOMImplementation();
		const doc = dom.createDocument(null, "turn", null);
		const turn = new Turn(doc);

		await hooks.ask.completed.emit({ turn });

		const exists = await fs
			.stat(auditFile)
			.then(() => true)
			.catch(() => false);
		assert.ok(exists, "Audit file should have been written");
	});
});
