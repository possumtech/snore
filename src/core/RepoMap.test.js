import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RepoMap from "./RepoMap.js";

describe("RepoMap (Hybrid HD/Standard)", () => {
	const testDir = join(process.cwd(), "test_hybrid");

	before(async () => {
		await fs.mkdir(testDir, { recursive: true });
		await fs.writeFile(join(testDir, "service.js"), "export class MyClass { method() {} }");
		await fs.writeFile(join(testDir, "script.py"), "def my_func(): pass");
	});

	after(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("should use HD for JS and Standard for Python", async () => {
		const mockCtx = {
			root: testDir,
			getMappableFiles: async () => ["service.js", "script.py"],
		};

		const repoMap = new RepoMap(mockCtx);
		const map = await repoMap.generate();

		const jsFile = map.files.find(f => f.path === "service.js");
		const pyFile = map.files.find(f => f.path === "script.py");

		assert.ok(jsFile, "JS file should be mapped");
		assert.strictEqual(jsFile.source, "hd");
		assert.ok(jsFile.symbols.some(s => s.name === "MyClass"));

		assert.ok(pyFile, "Python file should be mapped");
		// Python is not in our HD list, so it shouldn't have source 'hd'
		assert.notStrictEqual(pyFile.source, "hd");
		assert.ok(pyFile.symbols.length > 0, "Python should have symbols via Ctags");
	});
});
