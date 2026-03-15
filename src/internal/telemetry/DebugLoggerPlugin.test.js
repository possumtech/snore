import assert from "node:assert";
import fs from "node:fs/promises";
import { after, before, describe, it, mock } from "node:test";
import HookRegistry from "../../core/HookRegistry.js";
import Turn from "../../core/Turn.js";
import DebugLoggerPlugin from "./DebugLoggerPlugin.js";

describe("DebugLoggerPlugin", () => {
	const auditFile = "audit_last_turn.xml";

	before(() => {
		process.env.SNORE_DEBUG = "true";
	});

	after(async () => {
		delete process.env.SNORE_DEBUG;
	});

	it("should register and log events and audits", async () => {
		const hooks = new HookRegistry();
		const logMock = mock.method(console, "log", () => {});

		DebugLoggerPlugin.register(hooks);

		await hooks.doAction("project_initialized", {
			projectId: "p1",
			projectPath: "/path",
		});
		await hooks.doAction("job_started", { jobId: "j1", type: "ask" });

		const turn = new Turn();
		turn.system.content.add("sys", 10);
		turn.assistant.content.add("resp", 10);

		await hooks.doAction("ask_completed", { turn });

		assert.ok(logMock.mock.callCount() >= 3);

		const exists = await fs
			.stat(auditFile)
			.then(() => true)
			.catch(() => false);
		assert.ok(exists, "Audit file should have been written");

		logMock.mock.restore();
	});
});
