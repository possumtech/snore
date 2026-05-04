/**
 * `log://turn_0/repo/manifest` entry contract.
 *
 * Covers @project_manifest — the `rummy.repo` plugin's run-start
 * orientation entry. Verifies: a single visible manifest is registered
 * after the first scan; the body is a flat `* path - N tokens` list
 * with no headers/legend/absolute path; subsequent scans do NOT
 * mutate it (turn-0 snapshot, cache-stable); file entries default to
 * `archived`; `noRepo: true` skips the scan entirely.
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
	const root = join(tmpdir(), `rummy_project_manifest_${name}_${Date.now()}`);
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

describe("project manifest (@project_manifest)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("project_manifest");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("scan registers a single visible log://turn_0/repo/manifest entry", async () => {
		const root = await makeProject("basic");
		const { runId, projectId } = await tdb.seedRun({
			alias: "manifest_basic",
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
			"log://turn_0/repo/manifest",
		);
		assert.strictEqual(matches.length, 1, "one manifest entry registered");
		assert.strictEqual(
			matches[0].visibility,
			"visible",
			"manifest is visible at write",
		);
	});

	it("manifest body is a flat `* path - N tokens` list with no headers, legend, or absolute path", async () => {
		const root = await makeProject("body");
		const { runId, projectId } = await tdb.seedRun({
			alias: "manifest_body",
			projectRoot: root,
		});

		const entries = await fireTurnStarted({
			tdb,
			runId,
			projectId,
			projectRoot: root,
		});
		const body = await entries.getBody(runId, "log://turn_0/repo/manifest");
		assert.ok(body, "manifest body exists");
		const lines = body.split("\n").filter((l) => l.length > 0);
		assert.ok(lines.length > 0, "manifest lists at least one file");
		for (const line of lines) {
			assert.match(
				line,
				/^\* [^\s].* - \d+ tokens$/,
				`every line is "* path - N tokens" — got ${JSON.stringify(line)}`,
			);
		}
		assert.match(body, /README\.md/, "root README.md is named");
		assert.match(body, /src\/a\.js/, "nested files use full relative path");
		assert.ok(!body.includes("##"), "no markdown headings");
		assert.ok(!body.includes("Navigate"), "no navigation legend");
		assert.ok(!body.includes("Constraints"), "no constraints section");
		assert.ok(!body.includes("Directories"), "no directory aggregation");
		assert.ok(!body.includes(root), "no absolute filesystem path leak");
	});

	it("subsequent scans do NOT rewrite the manifest (turn-0 snapshot, cache-stable)", async () => {
		const root = await makeProject("stable");
		const { runId, projectId } = await tdb.seedRun({
			alias: "manifest_stable",
			projectRoot: root,
		});

		const entries = await fireTurnStarted({
			tdb,
			runId,
			projectId,
			projectRoot: root,
		});
		const firstBody = await entries.getBody(
			runId,
			"log://turn_0/repo/manifest",
		);

		writeFileSync(join(root, "added_later.js"), "export const z = 0;\n");
		await fireTurnStarted({ tdb, runId, projectId, projectRoot: root });
		const secondBody = await entries.getBody(
			runId,
			"log://turn_0/repo/manifest",
		);

		assert.strictEqual(
			firstBody,
			secondBody,
			"manifest body is bit-identical across scans (no cache-bust)",
		);
		assert.ok(
			!secondBody.includes("added_later.js"),
			"manifest must not list files added after run start",
		);
	});

	it("file entries default to archived (not summarized)", async () => {
		const root = await makeProject("archived");
		const { runId, projectId } = await tdb.seedRun({
			alias: "manifest_archived",
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

	it("noRepo: true skips the scan; no manifest, no file entries", async () => {
		const root = await makeProject("norepo");
		const { runId, projectId } = await tdb.seedRun({
			alias: "manifest_norepo",
			projectRoot: root,
		});

		const entries = await fireTurnStarted({
			tdb,
			runId,
			projectId,
			projectRoot: root,
			noRepo: true,
		});

		const manifest = await entries.getEntriesByPattern(
			runId,
			"log://turn_0/repo/manifest",
		);
		assert.strictEqual(manifest.length, 0, "no manifest when noRepo");
		const files = await entries.getEntriesByPattern(runId, "src/a.js");
		assert.strictEqual(files.length, 0, "no file entries when noRepo");
	});
});
