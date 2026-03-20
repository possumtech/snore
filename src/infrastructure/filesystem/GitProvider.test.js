import assert from "node:assert";
import test, { mock } from "node:test";
import git from "isomorphic-git";
import GitProvider from "./GitProvider.js";

test("GitProvider", async (t) => {
	await t.test("detectRoot should return null on error", async () => {
		const findRootMock = mock.method(git, "findRoot", () => {
			throw new Error("no root");
		});
		const root = await GitProvider.detectRoot("/any");
		assert.strictEqual(root, null);
		findRootMock.mock.restore();
	});

	await t.test("getTrackedFiles should return empty set on error", async () => {
		const listFilesMock = mock.method(git, "listFiles", () => {
			throw new Error("no files");
		});
		const files = await GitProvider.getTrackedFiles("/any");
		assert.ok(files instanceof Set);
		assert.strictEqual(files.size, 0);
		listFilesMock.mock.restore();
	});

	await t.test("isIgnored should return false on error", async () => {
		const isIgnoredMock = mock.method(git, "isIgnored", () => {
			throw new Error("error");
		});
		const ignored = await GitProvider.isIgnored("/any", "file.txt");
		assert.strictEqual(ignored, false);
		isIgnoredMock.mock.restore();
	});

	await t.test("getHeadHash should return null on error", async () => {
		const resolveRefMock = mock.method(git, "resolveRef", () => {
			throw new Error("error");
		});
		const hash = await GitProvider.getHeadHash("/any");
		assert.strictEqual(hash, null);
		resolveRefMock.mock.restore();
	});
});
