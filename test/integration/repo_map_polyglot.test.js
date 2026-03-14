import assert from "node:assert";
import fs from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import RepoMap from "../../src/core/RepoMap.js";

describe("RepoMap Polyglot Integration", () => {
	const testDir = join(process.cwd(), "test_polyglot");

	before(async () => {
		await fs.mkdir(testDir, { recursive: true });
		// Create files in multiple languages
		await fs.writeFile(join(testDir, "main.py"), "class PyClass:\n    def method(self): pass");
		await fs.writeFile(join(testDir, "lib.rs"), "struct RustStruct { x: i32 }\nfn rust_func() {}");
		await fs.writeFile(join(testDir, "app.go"), "package main\nfunc main() {}");
	});

	after(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("should generate a map for a multi-language project", async () => {
		const mockCtx = {
			root: testDir,
			getMappableFiles: async () => ["main.py", "lib.rs", "app.go"],
		};

		const repoMap = new RepoMap(mockCtx);
		const map = await repoMap.generate();

		assert.ok(map.files.length === 3);
		assert.ok(typeof map.raw === "string");
		// Verify symbols from different languages are present in the raw output
		assert.ok(map.raw.includes("PyClass"), "Should contain Python class");
		assert.ok(map.raw.includes("RustStruct"), "Should contain Rust struct");
		assert.ok(map.raw.includes("func main"), "Should contain Go function");
	});
});
