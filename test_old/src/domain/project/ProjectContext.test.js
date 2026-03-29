import { ok, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import GitProvider from "../../infrastructure/filesystem/GitProvider.js";
import ProjectContext from "./ProjectContext.js";

describe("ProjectContext", () => {
	it("should initialize correctly as a git project", async () => {
		const root = "/project";
		const detectMock = mock.method(
			GitProvider,
			"detectRoot",
			async () => "/project",
		);
		const trackMock = mock.method(GitProvider, "getTrackedFiles", async () => [
			"src/a.js",
			"src/b.js",
		]);

		const context = await ProjectContext.open(root);

		strictEqual(context.root, root);
		strictEqual(context.isGit, true);

		const mappable = await context.getMappableFiles();
		ok(mappable.includes("src/a.js"));
		ok(mappable.includes("src/b.js"));

		detectMock.mock.restore();
		trackMock.mock.restore();
	});

	it("should report project membership for git-tracked files", async () => {
		const root = "/project";
		mock.method(GitProvider, "detectRoot", async () => "/project");
		mock.method(GitProvider, "getTrackedFiles", async () => ["tracked.js"]);

		const context = await ProjectContext.open(root);

		strictEqual(await context.isInProject("tracked.js"), true);
		strictEqual(await context.isInProject("untracked.js"), false);
	});

	it("should include dbFiles in project membership", async () => {
		const root = "/project";
		mock.method(GitProvider, "detectRoot", async () => null);

		const dbFiles = new Set(["added.js"]);
		const context = await ProjectContext.open(root, dbFiles);

		strictEqual(await context.isInProject("added.js"), true);
		strictEqual(await context.isInProject("other.js"), false);

		const mappable = await context.getMappableFiles();
		ok(mappable.includes("added.js"));
	});

	it("should handle non-git project", async () => {
		mock.method(GitProvider, "detectRoot", async () => null);

		const context = await ProjectContext.open("/non-git");
		strictEqual(context.isGit, false);

		const mappable = await context.getMappableFiles();
		strictEqual(mappable.length, 0);
	});
});
