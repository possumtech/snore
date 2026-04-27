/**
 * `repo://overview` entry contract.
 *
 * Covers @repo_overview — the `rummy.repo` plugin's navigation entry.
 * Verifies: a single visible `repo://overview` is registered after a
 * scan; file entries default to `archived` (not `summarized`); the
 * overview body carries the documented sections; setting `noRepo`
 * skips the scan entirely.
 */
import assert from "node:assert";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

async function makeProject(name) {
	const root = join(tmpdir(), `rummy_repo_overview_${name}_${Date.now()}`);
	await fs.mkdir(root, { recursive: true });
	writeFileSync(join(root, "README.md"), "# Project\n");
	writeFileSync(join(root, "main.js"), "export const x = 1;\n");
	await fs.mkdir(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.js"), "export const a = 'a';\n");
	writeFileSync(join(root, "src", "b.js"), "export const b = 'b';\n");
	execSync(
		'git init && git config user.email "t@t" && git config user.name T && git add . && git commit --no-verify -m "init"',
		{ cwd: root },
	);
	return root;
}

async function fireTurnStarted({ tdb, runId, projectId, projectRoot, noRepo }) {
	const entries = new Entries(tdb.db);
	entries.loadSchemes(tdb.db);
	const loopId = 1;
	// loop.started seeds the per-loop strike state that other listeners
	// (error plugin) expect on turn.started. Fire it first so the chain
	// has the state it needs.
	await tdb.hooks.loop.started.emit({ runId, loopId });
	const rummy = {
		runId,
		projectId,
		loopId,
		project: { id: projectId, project_root: projectRoot },
		entries,
		db: tdb.db,
		hooks: tdb.hooks,
		sequence: 1,
		noRepo: noRepo === true,
	};
	await tdb.hooks.turn.started.emit({ rummy });
	return entries;
}

describe("repo overview (@repo_overview)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("repo_overview");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("scan registers a single visible repo://overview entry", async () => {
		const root = await makeProject("basic");
		const { runId, projectId } = await tdb.seedRun({
			alias: "repo_basic",
			projectRoot: root,
		});

		const entries = await fireTurnStarted({
			tdb,
			runId,
			projectId,
			projectRoot: root,
		});

		const matches = await entries.getEntriesByPattern(
			runId,
			"repo://overview",
		);
		assert.strictEqual(matches.length, 1, "one repo://overview registered");
		assert.strictEqual(
			matches[0].visibility,
			"visible",
			"overview is visible by default",
		);
	});

	it("overview body contains expected sections", async () => {
		const root = await makeProject("body");
		const { runId, projectId } = await tdb.seedRun({
			alias: "repo_body",
			projectRoot: root,
		});

		const entries = await fireTurnStarted({
			tdb,
			runId,
			projectId,
			projectRoot: root,
		});
		const overview = await entries.getBody(runId, "repo://overview");
		assert.ok(overview, "overview body exists");
		assert.match(overview, /^# .+/, "starts with project header");
		assert.match(overview, /Root files/, "lists root files");
		assert.match(overview, /Directories/, "lists top-level directories");
		assert.match(overview, /Navigate/, "carries the navigation legend");
		assert.match(overview, /README\.md/, "root README.md is named");
		assert.match(overview, /src\//, "src directory appears");
	});

	it("file entries default to archived (not summarized)", async () => {
		const root = await makeProject("archived");
		const { runId, projectId } = await tdb.seedRun({
			alias: "repo_archived",
			projectRoot: root,
		});

		const entries = await fireTurnStarted({
			tdb,
			runId,
			projectId,
			projectRoot: root,
		});

		const fileMatches = await entries.getEntriesByPattern(runId, "src/a.js");
		assert.strictEqual(fileMatches.length, 1, "src/a.js registered");
		assert.strictEqual(
			fileMatches[0].visibility,
			"archived",
			"new file defaults to archived under the new behaviour",
		);
	});

	it("noRepo: true skips the scan; no overview, no file entries", async () => {
		const root = await makeProject("norepo");
		const { runId, projectId } = await tdb.seedRun({
			alias: "repo_norepo",
			projectRoot: root,
		});

		const entries = await fireTurnStarted({
			tdb,
			runId,
			projectId,
			projectRoot: root,
			noRepo: true,
		});

		const overview = await entries.getEntriesByPattern(
			runId,
			"repo://overview",
		);
		assert.strictEqual(overview.length, 0, "no overview when noRepo");
		const files = await entries.getEntriesByPattern(runId, "src/a.js");
		assert.strictEqual(files.length, 0, "no file entries when noRepo");
	});
});
