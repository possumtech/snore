import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import FileScanner from "../../src/agent/FileScanner.js";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("FileScanner integration", () => {
	let tdb, store, scanner, PROJECT_ID, RUN_ID;
	const projectPath = join(tmpdir(), `rummy-scanner-${Date.now()}`);

	before(async () => {
		await fs.mkdir(projectPath, { recursive: true });

		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun({
			path: projectPath,
			name: "ScannerTest",
			alias: "scan_1",
		});
		PROJECT_ID = seed.projectId;
		RUN_ID = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	it("adds new files to the store", async () => {
		await fs.writeFile(join(projectPath, "app.js"), "const x = 1;\n");

		scanner = new FileScanner(store, tdb.db, null);
		await scanner.scan(projectPath, PROJECT_ID, ["app.js"], 1);

		const entries = await store.getFileEntries(RUN_ID);
		const app = entries.find((e) => e.path === "app.js");
		assert.ok(app, "app.js should be in store");
		assert.strictEqual(app.state, "full");
		assert.ok(app.hash, "should have hash");
	});

	it("skips unchanged files (mtime within tolerance)", async () => {
		const entriesBefore = await store.getFileEntries(RUN_ID);
		const appBefore = entriesBefore.find((e) => e.path === "app.js");

		// Scan again without touching the file
		await scanner.scan(projectPath, PROJECT_ID, ["app.js"], 2);

		const entriesAfter = await store.getFileEntries(RUN_ID);
		const appAfter = entriesAfter.find((e) => e.path === "app.js");
		assert.strictEqual(appAfter.hash, appBefore.hash, "hash should not change");
	});

	it("detects content changes via hash", async () => {
		const entriesBefore = await store.getFileEntries(RUN_ID);
		const hashBefore = entriesBefore.find((e) => e.path === "app.js").hash;

		// Change file content and set mtime 2 seconds in the future
		// to exceed the 1-second tolerance
		await fs.writeFile(join(projectPath, "app.js"), "const x = 2;\n");
		const future = new Date(Date.now() + 2000);
		await fs.utimes(join(projectPath, "app.js"), future, future);

		await scanner.scan(projectPath, PROJECT_ID, ["app.js"], 3);

		const entriesAfter = await store.getFileEntries(RUN_ID);
		const hashAfter = entriesAfter.find((e) => e.path === "app.js").hash;
		assert.notStrictEqual(hashAfter, hashBefore, "hash should change");
	});

	it("removes deleted files from store", async () => {
		await fs.writeFile(join(projectPath, "temp.js"), "// temp\n");
		await scanner.scan(projectPath, PROJECT_ID, ["app.js", "temp.js"], 4);

		let entries = await store.getFileEntries(RUN_ID);
		assert.ok(
			entries.find((e) => e.path === "temp.js"),
			"temp.js should exist",
		);

		// Delete from disk, scan without it in mappableFiles
		await fs.unlink(join(projectPath, "temp.js"));
		await scanner.scan(projectPath, PROJECT_ID, ["app.js"], 5);

		entries = await store.getFileEntries(RUN_ID);
		assert.ok(
			!entries.find((e) => e.path === "temp.js"),
			"temp.js should be removed",
		);
	});

	it("calls symbol extraction hook for changed files", async () => {
		const symbolCalls = [];
		const hooks = {
			file: {
				symbols: {
					filter: async (_map, { paths }) => {
						symbolCalls.push(paths);
						const result = new Map();
						for (const p of paths) {
							result.set(p, [{ name: "main", kind: "function", line: 1 }]);
						}
						return result;
					},
				},
			},
		};

		await fs.writeFile(join(projectPath, "sym.js"), "function main() {}\n");
		const hookScanner = new FileScanner(store, tdb.db, hooks);
		await hookScanner.scan(projectPath, PROJECT_ID, ["sym.js"], 6);

		assert.strictEqual(symbolCalls.length, 1, "symbols hook called once");
		assert.ok(symbolCalls[0].includes("sym.js"), "hook received changed path");
	});

	it("only active-constrained files get current turn, all others get 0", async () => {
		await fs.mkdir(join(projectPath, "src"), { recursive: true });
		await fs.writeFile(join(projectPath, "root.js"), "// root\n");
		await fs.writeFile(join(projectPath, "src/nested.js"), "// nested\n");
		await fs.writeFile(join(projectPath, "active.js"), "// active\n");

		// Set active constraint on one file
		await tdb.db.upsert_file_constraint.run({
			project_id: PROJECT_ID,
			pattern: "active.js",
			visibility: "active",
		});

		await scanner.scan(
			projectPath,
			PROJECT_ID,
			["root.js", "src/nested.js", "active.js"],
			7,
		);

		const all = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
		const root = all.find((e) => e.path === "root.js");
		const nested = all.find((e) => e.path === "src/nested.js");
		const active = all.find((e) => e.path === "active.js");
		assert.strictEqual(
			root.turn,
			0,
			"root file gets turn 0 (no special treatment)",
		);
		assert.strictEqual(nested.turn, 0, "nested file gets turn 0");
		assert.strictEqual(
			active.turn,
			7,
			"active-constrained file gets current turn",
		);
	});
});
