import assert from "node:assert";
import test from "node:test";
import GitProvider from "./GitProvider.js";

test("GitProvider", async (t) => {
	await t.test(
		"detectRoot should return null for non-git directory",
		async () => {
			const root = await GitProvider.detectRoot("/tmp");
			assert.strictEqual(root, null);
		},
	);

	await t.test("detectRoot should find root for git directory", async () => {
		const root = await GitProvider.detectRoot(process.cwd());
		assert.ok(root, "Should find git root for current project");
	});

	await t.test("getTrackedFiles should return set of files", async () => {
		const root = await GitProvider.detectRoot(process.cwd());
		if (!root) return;
		const files = await GitProvider.getTrackedFiles(root);
		assert.ok(files instanceof Set);
		assert.ok(files.size > 0, "Should have tracked files");
		assert.ok(files.has("package.json"), "Should track package.json");
	});

	await t.test("getTrackedFiles should return empty set on error", async () => {
		const files = await GitProvider.getTrackedFiles("/nonexistent/path");
		assert.ok(files instanceof Set);
		assert.strictEqual(files.size, 0);
	});

	await t.test("isIgnored should return true for node_modules", async () => {
		const root = await GitProvider.detectRoot(process.cwd());
		if (!root) return;
		const ignored = await GitProvider.isIgnored(root, "node_modules/ws");
		assert.strictEqual(ignored, true);
	});

	await t.test("isIgnored should return false for tracked files", async () => {
		const root = await GitProvider.detectRoot(process.cwd());
		if (!root) return;
		const ignored = await GitProvider.isIgnored(root, "package.json");
		assert.strictEqual(ignored, false);
	});

	await t.test("getHeadHash should return a hash string", async () => {
		const root = await GitProvider.detectRoot(process.cwd());
		if (!root) return;
		const hash = await GitProvider.getHeadHash(root);
		assert.ok(hash, "Should return a hash");
		assert.ok(/^[a-f0-9]{40}$/.test(hash), "Should be a 40-char hex string");
	});

	await t.test("getHeadHash should return null on error", async () => {
		const hash = await GitProvider.getHeadHash("/nonexistent/path");
		assert.strictEqual(hash, null);
	});
});
