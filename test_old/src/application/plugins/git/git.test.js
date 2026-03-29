import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import createHooks from "../../../domain/hooks/Hooks.js";
import FileChangePlugin from "./git.js";

test("FileChangePlugin", async (t) => {
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
		FileChangePlugin.register(hooks);

		await fs.writeFile(join(projectPath, filePath), "modified");

		let tagCalled = false;
		const mockRummy = {
			project: { id: "p1", path: projectPath },
			db: {
				get_project_repo_map: { all: async () => [{ path: filePath, hash }] },
			},
			tag: (name, _attrs, children) => {
				tagCalled = true;
				assert.strictEqual(name, "modified_files");
				assert.ok(children[0].includes(filePath));
				return { tag: name, attrs: {}, content: children[0], children: [] };
			},
			contextEl: { children: [] },
		};

		await hooks.processTurn(mockRummy);
		assert.ok(tagCalled, "modified_files tag should have been created");
	});
});
