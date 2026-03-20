import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import createHooks from "../../../domain/hooks/Hooks.js";
import GitPlugin from "./git.js";

test("GitPlugin", async (t) => {
	const projectPath = join(process.cwd(), "test_git_plugin");
	await fs.mkdir(projectPath, { recursive: true });
	const filePath = "test.txt";
	const content = "hello";
	await fs.writeFile(join(projectPath, filePath), content);
	const hash = crypto.createHash("sha256").update(content).digest("hex");

	t.after(
		async () => await fs.rm(projectPath, { recursive: true, force: true }),
	);

	await t.test("onTurn should detect modified files", async () => {
		const hooks = createHooks();
		GitPlugin.register(hooks);

		// Modify file to trigger hash mismatch
		await fs.writeFile(join(projectPath, filePath), "modified");

		let tagCalled = false;
		const mockRummy = {
			project: { id: "p1", path: projectPath },
			db: {
				get_project_repo_map: { all: async () => [{ path: filePath, hash }] },
			},
			tag: (name, _attrs, children) => {
				tagCalled = true;
				assert.strictEqual(name, "git_changes");
				assert.ok(children[0].includes(filePath));
				return {};
			},
			contextEl: { appendChild: () => {} },
		};

		await hooks.processTurn(mockRummy);
		assert.ok(tagCalled, "git_changes tag should have been created");
	});
});
