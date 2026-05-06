/**
 * File freshness — the model's view must always be a faithful and
 * fresh presentation of the current filesystem state.
 *
 * Covers @filesystem_freshness — the invariant that after any
 * mutation of a file or scheme entry, the next turn's assembled
 * context reflects the post-mutation body AND visibility, without
 * the model needing a fresh `<get>` to recover its own changes.
 *
 * The bug these tests lock against: SEARCH/REPLACE accept-path
 * silently downgrading visibility from `visible` → `summarized`,
 * which leaves the body present in the entry but invisible to the
 * model (file plugin's summary projection is empty). The model on
 * the next turn answers from memory of pre-edit state instead of
 * seeing what just landed.
 */
import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AgentLoop from "../../src/agent/AgentLoop.js";
import Entries from "../../src/agent/Entries.js";
import TurnExecutor from "../../src/agent/TurnExecutor.js";
import LlmProvider from "../../src/llm/LlmProvider.js";
import TestDb from "../helpers/TestDb.js";

async function makeAgent(tdb) {
	const llm = new LlmProvider(tdb.db, tdb.hooks);
	const entries = new Entries(tdb.db);
	entries.loadSchemes(tdb.db);
	const turnExecutor = new TurnExecutor(tdb.db, llm, tdb.hooks, entries);
	const agent = new AgentLoop(tdb.db, llm, tdb.hooks, turnExecutor, entries);
	return { agent, entries };
}

async function seedProjectWithFile(tdb, alias, fileName, originalContent) {
	const projectRoot = join(tmpdir(), `file_freshness_${alias}_${Date.now()}`);
	const fullPath = join(projectRoot, fileName);
	await fs.mkdir(join(fullPath, ".."), { recursive: true });
	await fs.writeFile(fullPath, originalContent);
	const { runId, projectId } = await tdb.seedRun({ alias, projectRoot });
	return { projectRoot, runId, projectId };
}

describe("file freshness (@filesystem_freshness)", () => {
	let tdb;
	let agent;
	let entries;

	before(async () => {
		tdb = await TestDb.create("file_freshness");
		const out = await makeAgent(tdb);
		agent = out.agent;
		entries = out.entries;
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("SEARCH/REPLACE accept", () => {
		it("entry body matches new content on disk", async () => {
			const { projectRoot, runId } = await seedProjectWithFile(
				tdb,
				"sr_body_sync",
				"src/app.js",
				"const x = 1;\n// TODO: stuff\n",
			);
			// Pre-promote so we test the preservation path
			await entries.set({
				runId,
				path: "src/app.js",
				body: "const x = 1;\n// TODO: stuff\n",
				state: "resolved",
				visibility: "visible",
				writer: "plugin",
			});

			const proposalPath = await entries.logPath(runId, 1, "set", "src/app.js");
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "(merge proposal)",
				state: "proposed",
				attributes: {
					path: "src/app.js",
					merge:
						"<<<<<<< SEARCH\n// TODO: stuff\n=======\n// stuff handled\n>>>>>>> REPLACE",
				},
			});

			await agent.resolve("sr_body_sync", {
				path: proposalPath,
				action: "accept",
			});

			const entryBody = await entries.getBody(runId, "src/app.js");
			const onDisk = await fs.readFile(join(projectRoot, "src/app.js"), "utf8");
			assert.strictEqual(
				entryBody,
				onDisk,
				"entry body matches disk after SEARCH/REPLACE accept",
			);
			assert.ok(
				entryBody.includes("// stuff handled"),
				"new content present in entry",
			);
			assert.ok(!entryBody.includes("// TODO: stuff"), "old content replaced");
		});

		it("preserves visibility=visible after edit (no silent downgrade)", async () => {
			const { runId } = await seedProjectWithFile(
				tdb,
				"sr_vis_preserve_visible",
				"src/app.js",
				"const x = 1;\n// TODO: stuff\n",
			);
			await entries.set({
				runId,
				path: "src/app.js",
				body: "const x = 1;\n// TODO: stuff\n",
				state: "resolved",
				visibility: "visible",
				writer: "plugin",
			});

			const proposalPath = await entries.logPath(runId, 1, "set", "src/app.js");
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "(merge proposal)",
				state: "proposed",
				attributes: {
					path: "src/app.js",
					merge:
						"<<<<<<< SEARCH\n// TODO: stuff\n=======\n// stuff handled\n>>>>>>> REPLACE",
				},
			});

			await agent.resolve("sr_vis_preserve_visible", {
				path: proposalPath,
				action: "accept",
			});

			const state = await entries.getState(runId, "src/app.js");
			assert.strictEqual(
				state?.visibility,
				"visible",
				"visibility=visible preserved across SEARCH/REPLACE accept",
			);
		});

		it("preserves visibility=summarized after edit", async () => {
			const { runId } = await seedProjectWithFile(
				tdb,
				"sr_vis_preserve_summarized",
				"src/app.js",
				"const x = 1;\n// TODO: stuff\n",
			);
			await entries.set({
				runId,
				path: "src/app.js",
				body: "const x = 1;\n// TODO: stuff\n",
				state: "resolved",
				visibility: "summarized",
				writer: "plugin",
			});

			const proposalPath = await entries.logPath(runId, 1, "set", "src/app.js");
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "(merge proposal)",
				state: "proposed",
				attributes: {
					path: "src/app.js",
					merge:
						"<<<<<<< SEARCH\n// TODO: stuff\n=======\n// stuff handled\n>>>>>>> REPLACE",
				},
			});

			await agent.resolve("sr_vis_preserve_summarized", {
				path: proposalPath,
				action: "accept",
			});

			const state = await entries.getState(runId, "src/app.js");
			assert.strictEqual(
				state?.visibility,
				"summarized",
				"visibility=summarized preserved across SEARCH/REPLACE accept",
			);
		});

		it("new file from SEARCH/REPLACE lands at visible (model just wrote it)", async () => {
			const { projectRoot, runId } = await seedProjectWithFile(
				tdb,
				"sr_new_file",
				"placeholder.txt",
				"placeholder",
			);
			const proposalPath = await entries.logPath(runId, 1, "set", "src/new.js");
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "(merge proposal)",
				state: "proposed",
				attributes: {
					path: "src/new.js",
					merge: "<<<<<<< SEARCH\n=======\nconst y = 2;\n>>>>>>> REPLACE",
				},
			});

			await agent.resolve("sr_new_file", {
				path: proposalPath,
				action: "accept",
			});

			const state = await entries.getState(runId, "src/new.js");
			const body = await entries.getBody(runId, "src/new.js");
			assert.strictEqual(body, "const y = 2;", "new file body landed");
			assert.strictEqual(
				state?.visibility,
				"visible",
				"newly-created file lands at visible — the model just wrote it; it should see what it created",
			);
			const onDisk = await fs.readFile(join(projectRoot, "src/new.js"), "utf8");
			assert.strictEqual(onDisk, "const y = 2;", "disk in sync");
		});
	});

	describe("entry-layer write (no proposal)", () => {
		it("scheme write: visibility preserved across body update", async () => {
			const { runId } = await seedProjectWithFile(
				tdb,
				"scheme_vis_preserve",
				"placeholder.txt",
				"placeholder",
			);
			await entries.set({
				runId,
				path: "known://fact",
				body: "first version",
				state: "resolved",
				visibility: "visible",
				writer: "model",
			});
			await entries.set({
				runId,
				path: "known://fact",
				body: "second version",
				state: "resolved",
				writer: "model",
			});

			const state = await entries.getState(runId, "known://fact");
			assert.strictEqual(
				state?.visibility,
				"visible",
				"visibility preserved when only body is updated",
			);
			const body = await entries.getBody(runId, "known://fact");
			assert.strictEqual(body, "second version", "body updated");
		});
	});
});
