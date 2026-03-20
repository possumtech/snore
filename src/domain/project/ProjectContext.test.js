import { ok, strictEqual } from "node:assert";
import { describe, it, mock } from "node:test";
import GitProvider from "../../infrastructure/filesystem/GitProvider.js";
import ProjectContext, { FileState } from "./ProjectContext.js";

describe("ProjectContext", () => {
	it("should initialize correctly as a git project", async () => {
		const root = "/project";
		const detectRootMock = mock.method(
			GitProvider,
			"detectRoot",
			async () => "/project",
		);
		const getTrackedFilesMock = mock.method(
			GitProvider,
			"getTrackedFiles",
			async () => ["src/a.js", "src/b.js"],
		);

		const context = await ProjectContext.open(root);

		strictEqual(context.root, root);
		strictEqual(context.isGit, true);

		const mappable = await context.getMappableFiles();
		ok(mappable.includes("src/a.js"));
		ok(mappable.includes("src/b.js"));

		detectRootMock.mock.restore();
		getTrackedFilesMock.mock.restore();
	});

	it("should resolve state correctly for git projects", async () => {
		const root = "/project";
		mock.method(GitProvider, "detectRoot", async () => "/project");
		mock.method(GitProvider, "getTrackedFiles", async () => ["tracked.js"]);
		mock.method(GitProvider, "isIgnored", async (_r, p) => p === "ignored.js");

		const context = await ProjectContext.open(root);

		strictEqual(await context.resolveState("tracked.js"), FileState.MAPPABLE);
		strictEqual(await context.resolveState("ignored.js"), FileState.IGNORED);
		strictEqual(
			await context.resolveState("untracked.js"),
			FileState.INVISIBLE,
		);
	});

	it("should apply visibility overrides", async () => {
		const root = "/project";
		mock.method(GitProvider, "detectRoot", async () => null);

		const overrides = new Map([["special.js", FileState.ACTIVE]]);
		const context = await ProjectContext.open(root, overrides);

		strictEqual(await context.resolveState("special.js"), FileState.ACTIVE);
		strictEqual(await context.resolveState("other.js"), FileState.IGNORED); // Non-git fallback
	});
});
