import assert from "node:assert";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import FsProvider from "./FsProvider.js";

test("FsProvider", async (t) => {
	const testDir = join(process.cwd(), "test_fs_provider");
	if (!fs.existsSync(testDir)) fs.mkdirSync(testDir);

	fs.writeFileSync(join(testDir, "file1.txt"), "hello");
	const subDir = join(testDir, "sub");
	if (!fs.existsSync(subDir)) fs.mkdirSync(subDir);
	fs.writeFileSync(join(subDir, "file2.txt"), "world");

	t.after(() => {
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	await t.test("listFiles should list files recursively", () => {
		const files = FsProvider.listFiles(testDir);
		assert.ok(files.includes("file1.txt"));
		assert.ok(files.includes("sub/file2.txt"));
	});

	await t.test("getMtime should return 0 for non-existent file", () => {
		assert.strictEqual(FsProvider.getMtime("/non/existent"), 0);
	});
});
