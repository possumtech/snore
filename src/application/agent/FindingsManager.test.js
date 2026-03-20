import test from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import FindingsManager from "./FindingsManager.js";
import ResponseParser from "./ResponseParser.js";

test("FindingsManager", async (t) => {
	const mockDb = {
		get_project_by_path: { all: async (params) => {
            if (params.path === "/tmp") return [{ id: "p1" }];
            return [];
        }},
		get_findings_by_run_id: { all: async () => [] },
		get_unresolved_findings: { all: async () => [] },
		update_finding_diff_status: { run: async () => {} },
		update_finding_command_status: { run: async () => {} },
		update_finding_notification_status: { run: async () => {} },
		insert_finding_diff: { run: async () => {} },
		insert_finding_command: { run: async () => {} },
		insert_finding_notification: { run: async () => {} },
		set_retained: { run: async () => {} }
	};
	const parser = new ResponseParser();
	const manager = new FindingsManager(mockDb, parser);

	await t.test("populateFindings should extract various tags", async () => {
		const atomicResult = { runId: "r1", diffs: [], commands: [], notifications: [], content: "RUMMY_TEST_DIFF RUMMY_TEST_NOTIFY" };
		const tags = [
			{ tagName: "read", attrs: [{ name: "file", value: "logic.js" }] },
			{ tagName: "drop", attrs: [{ name: "file", value: "old.js" }] },
			{ tagName: "remark", isMock: true, childNodes: [{ value: "some remark" }] },
			{ tagName: "edit", attrs: [{ name: "file", value: "edit.js" }], isMock: true, childNodes: [{ value: "patch" }] },
			{ tagName: "delete", attrs: [{ name: "file", value: "del.js" }], isMock: true },
			{ tagName: "prompt_user", isMock: true, childNodes: [{ value: "Question?" }] },
			{ tagName: "summary", isMock: true, childNodes: [{ value: "Sum" }] },
			{ tagName: "analysis", isMock: true, childNodes: [{ value: "Ana" }] },
			{ tagName: "run", isMock: true, childNodes: [{ value: "ls" }] }
		];
		await manager.populateFindings("/tmp", atomicResult, tags);
		// 1. remark (short)
		// 2. prompt_user
		// 3. summary
		// 4. RUMMY_TEST_NOTIFY
		assert.strictEqual(atomicResult.notifications.length, 4); 
		assert.strictEqual(atomicResult.diffs.length, 3); // edit, delete, and RUMMY_TEST_DIFF
		assert.strictEqual(atomicResult.commands.length, 1);
		assert.strictEqual(atomicResult.analysis, "Ana");
	});

	await t.test("resolveOutstandingFindings should handle all categories", async (t) => {
		const runId = "r1";
		const projectPath = "/tmp";
		const findings = [
			{ id: 1, category: "diff", status: "proposed", type: "create", file: "res.txt", patch: "done" },
			{ id: 2, category: "command", status: "proposed", type: "run", command: "ls" },
			{ id: 3, category: "notification", status: "proposed", type: "prompt_user", text: "OK?" }
		];
		
		mockDb.get_unresolved_findings.all = async () => findings;
        mockDb.get_findings_by_run_id.all = async () => findings;
		
		const originalApply = manager.applyDiff;
		manager.applyDiff = async () => {};
		t.after(() => manager.applyDiff = originalApply);

		const infoTags = [
			{ tagName: "info", attrs: [{ name: "diff", value: "1" }], isMock: true, childNodes: [{ value: "accepted" }] },
			{ tagName: "info", attrs: [{ name: "command", value: "2" }], isMock: true, childNodes: [{ value: "rejected" }] },
			{ tagName: "info", attrs: [{ name: "notification", value: "3" }], isMock: true, childNodes: [{ value: "yes" }] }
		];

		const result = await manager.resolveOutstandingFindings(projectPath, runId, "prompt", infoTags);
		assert.strictEqual(result.resolvedCount, 3);
	});

	await t.test("applyDiff should handle create and delete types", async (t) => {
		const projectPath = join(process.cwd(), "test_apply_diff_mgr");
		await fs.mkdir(projectPath, { recursive: true });
		t.after(async () => await fs.rm(projectPath, { recursive: true, force: true }));

		await manager.applyDiff(projectPath, { type: "create", file: "hello.txt", patch: "world" });
		const content = await fs.readFile(join(projectPath, "hello.txt"), "utf8");
		assert.strictEqual(content, "world");

		await manager.applyDiff(projectPath, { type: "delete", file: "hello.txt" });
		const exists = await fs.access(join(projectPath, "hello.txt")).then(() => true).catch(() => false);
		assert.strictEqual(exists, false);
	});
});
