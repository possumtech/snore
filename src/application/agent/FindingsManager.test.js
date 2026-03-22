import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import FindingsManager from "./FindingsManager.js";
import ResponseParser from "./ResponseParser.js";
import HeuristicMatcher from "../../extraction/HeuristicMatcher.js";

test("FindingsManager Expanded Coverage", async (t) => {
	const mockDb = {
		get_project_by_path: {
			all: async (params) => {
				if (params.path === "/tmp") return [{ id: "p1" }];
				return [];
			},
		},
		get_findings_by_run_id: { all: async () => [] },
		get_unresolved_findings: { all: async () => [] },
		update_finding_diff_status: { run: async () => {} },
		update_finding_command_status: { run: async () => {} },
		update_finding_notification_status: { run: async () => {} },
		insert_finding_diff: { run: async () => {} },
		insert_finding_command: { run: async () => {} },
		insert_finding_notification: { run: async () => {} },
		set_retained: { run: async () => {} },
		upsert_repo_map_file: { run: async () => {} },
	};
	const parser = new ResponseParser();
	const manager = new FindingsManager(mockDb, parser);

	await t.test("populateFindings should handle persistence, diff, cmd, and notify tags", async () => {
		const atomicResult = {
			runId: "r1",
			diffs: [],
			commands: [],
			notifications: [],
			content: "RUMMY_TEST_DIFF RUMMY_TEST_NOTIFY",
		};
		const tags = [
			{ tagName: "read", attrs: [{ name: "file", value: "read.js" }] },
			{ tagName: "drop", attrs: [{ name: "file", value: "drop.js" }] },
			{ tagName: "create", attrs: [{ name: "file", value: "new.js" }], isMock: true, childNodes: [{ value: "content" }] },
			{ tagName: "env", isMock: true, childNodes: [{ value: "ls" }] },
			{ tagName: "summary", isMock: true, childNodes: [{ value: "Done" }] },
			{ tagName: "prompt_user", isMock: true, childNodes: [{ value: "OK?" }] },
		];

		await manager.populateFindings("/tmp", atomicResult, tags);
		
		assert.strictEqual(atomicResult.diffs.length, 2); // create + RUMMY_TEST_DIFF
		assert.strictEqual(atomicResult.commands.length, 1);
		assert.strictEqual(atomicResult.notifications.length, 3); // summary, prompt_user, RUMMY_TEST_NOTIFY
	});

	await t.test("resolveOutstandingFindings should handle rejections", async (t) => {
		const findings = [
			{ id: 1, category: "diff", status: "proposed", type: "create", file: "a.js", patch: "p" },
			{ id: 2, category: "command", status: "proposed", type: "run", command: "ls" },
		];
		mockDb.get_findings_by_run_id.all = async () => findings;

		const infoTags = [
			{ tagName: "info", attrs: [{ name: "diff", value: "1" }], isMock: true, childNodes: [{ value: "rejected" }] },
			{ tagName: "info", attrs: [{ name: "command", value: "2" }], isMock: true, childNodes: [{ value: "accepted" }] },
		];

		const result = await manager.resolveOutstandingFindings("/tmp", "r1", "prompt", infoTags);
		assert.strictEqual(result.resolvedCount, 2);
	});

	await t.test("applyDiff should handle edit type", async (t) => {
		const projectPath = join(process.cwd(), "test_apply_edit");
		await fs.mkdir(projectPath, { recursive: true });
		const filePath = join(projectPath, "edit.js");
		await fs.writeFile(filePath, "old content", "utf8");

		t.after(async () => await fs.rm(projectPath, { recursive: true, force: true }));

		// Mock HeuristicMatcher to return a patch
		const originalMatch = HeuristicMatcher.matchAndPatch;
		HeuristicMatcher.matchAndPatch = () => ({ patch: "new content" });

		await manager.applyDiff(projectPath, {
			type: "edit",
			file: "edit.js",
			patch: "new content"
		});

		const content = await fs.readFile(filePath, "utf8");
		assert.strictEqual(content, "new content");

		HeuristicMatcher.matchAndPatch = originalMatch;
	});

	await t.test("applyDiff should ignore errors on delete missing file", async (t) => {
		const projectPath = join(process.cwd(), "test_apply_delete_missing");
		await fs.mkdir(projectPath, { recursive: true });
		t.after(async () => await fs.rm(projectPath, { recursive: true, force: true }));

		// Should not throw
		await manager.applyDiff(projectPath, {
			type: "delete",
			file: "nonexistent.js"
		});
	});
});
