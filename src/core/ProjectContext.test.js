import assert from "node:assert";
import { describe, it, mock } from "node:test";
import FsProvider from "./FsProvider.js";
import GitProvider from "./GitProvider.js";
import ProjectContext, { FileState } from "./ProjectContext.js";

describe("ProjectContext", () => {
	it("should resolve states correctly in a Git project", async () => {
		// Mock GitProvider
		mock.method(GitProvider, "detectRoot", async () => "/repo");
		mock.method(
			GitProvider,
			"getTrackedFiles",
			async () => new Set(["src/main.js", "README.md"]),
		);
		mock.method(
			GitProvider,
			"isIgnored",
			async (_root, path) => path === "dist/bundle.js",
		);

		const ctx = await ProjectContext.open("/repo");

		assert.strictEqual(
			await ctx.resolveState("src/main.js"),
			FileState.MAPPABLE,
		);
		assert.strictEqual(
			await ctx.resolveState("dist/bundle.js"),
			FileState.IGNORED,
		);
		assert.strictEqual(
			await ctx.resolveState("new-file.js"),
			FileState.INVISIBLE,
		);
	});

	it("should resolve states in a non-Git project", async () => {
		mock.method(GitProvider, "detectRoot", async () => null);
		mock.method(FsProvider, "listFiles", () => [
			"src/index.js",
			"node_modules/pkg/index.js",
		]);

		const ctx = await ProjectContext.open("/non-repo");

		assert.strictEqual(
			await ctx.resolveState("src/index.js"),
			FileState.MAPPABLE,
		);
		assert.strictEqual(
			await ctx.resolveState("node_modules/pkg/index.js"),
			FileState.IGNORED,
		);
	});
});
