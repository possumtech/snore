/**
 * Proposal lifecycle — accept side effects per scheme.
 *
 * Covers @resolution, @file_constraints — the silent-failure paths
 * that let `startsWith("set://")` dead code rot for weeks. Each test
 * drives `AgentLoop.resolve` with action="accept" on a seeded
 * proposal and asserts the plugin's side effects actually landed:
 * bare-path entries created, file_constraints set, channel entries
 * seeded, source entries removed, etc.
 *
 * If these fail, the proposal plumbing is broken in a way no
 * unit test would catch.
 */
import assert from "node:assert";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import AgentLoop from "../../src/agent/AgentLoop.js";
import Entries from "../../src/agent/Entries.js";
import LlmProvider from "../../src/llm/LlmProvider.js";
import TurnExecutor from "../../src/agent/TurnExecutor.js";
import TestDb from "../helpers/TestDb.js";

async function makeAgent(tdb) {
	const llm = new LlmProvider(tdb.db, tdb.hooks);
	const entries = new Entries(tdb.db);
	entries.loadSchemes(tdb.db);
	const turnExecutor = new TurnExecutor(tdb.db, llm, tdb.hooks, entries);
	const agent = new AgentLoop(tdb.db, llm, tdb.hooks, turnExecutor, entries);
	return { agent, entries };
}

async function seedProject(tdb, alias) {
	const projectRoot = join(tmpdir(), `proposal_lifecycle_${alias}_${Date.now()}`);
	await fs.mkdir(projectRoot, { recursive: true });
	const { runId, projectId } = await tdb.seedRun({ alias, projectRoot });
	return { projectRoot, runId, projectId };
}

describe("proposal lifecycle (@resolution)", () => {
	let tdb;
	let agent;
	let entries;

	before(async () => {
		tdb = await TestDb.create("proposal_lifecycle");
		const out = await makeAgent(tdb);
		agent = out.agent;
		entries = out.entries;
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("set proposal accept", () => {
		it("creates bare-path entry with patched content", async () => {
			const { projectRoot, runId } = await seedProject(tdb, "set_bare_path");
			const proposalPath = await entries.logPath(runId, 1, "set", "a.md");
			const newContent = "# A\nbody line";
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: newContent,
				state: "proposed",
				attributes: {
					path: "a.md",
					merge: `<<<<<<< SEARCH\n=======\n${newContent}\n>>>>>>> REPLACE`,
				},
			});

			await agent.resolve("set_bare_path", {
				path: proposalPath,
				action: "accept",
			});

			const landed = await entries.getBody(runId, "a.md");
			assert.strictEqual(
				landed,
				newContent,
				"bare-path entry created with the model's proposed content",
			);

			const onDisk = await fs.readFile(join(projectRoot, "a.md"), "utf8");
			assert.strictEqual(onDisk, newContent, "file written to disk");

			const constraints = await tdb.db.get_file_constraints.all({
				project_id: (await tdb.db.get_run_by_alias.get({ alias: "set_bare_path" }))
					.project_id,
			});
			const active = constraints.find(
				(c) => c.pattern === "a.md" && c.visibility === "active",
			);
			assert.ok(active, "new file registered as active in file_constraints");
		});

		it("readonly constraint vetoes accept with outcome=readonly", async () => {
			const { projectId, runId } = await seedProject(tdb, "set_readonly_veto");
			await tdb.db.upsert_file_constraint.run({
				project_id: projectId,
				pattern: "locked.md",
				visibility: "readonly",
			});
			const proposalPath = await entries.logPath(runId, 1, "set", "locked.md");
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "should not land",
				state: "proposed",
				attributes: {
					path: "locked.md",
					merge: "<<<<<<< SEARCH\n=======\nshould not land\n>>>>>>> REPLACE",
				},
			});

			const result = await agent.resolve("set_readonly_veto", {
				path: proposalPath,
				action: "accept",
			});

			assert.strictEqual(result.state, "failed");
			assert.strictEqual(result.outcome, "readonly");

			const landed = await entries.getBody(runId, "locked.md");
			assert.strictEqual(landed, null, "readonly veto prevents bare-path write");
		});
	});

	describe("rm proposal accept", () => {
		it("removes bare-path entry and unlinks disk file", async () => {
			const { projectRoot, runId } = await seedProject(tdb, "rm_accept");
			await fs.writeFile(join(projectRoot, "doomed.md"), "bye");
			await entries.set({
				runId,
				turn: 1,
				path: "doomed.md",
				body: "bye",
				state: "resolved",
			});
			const proposalPath = await entries.logPath(runId, 1, "rm", "doomed.md");
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "doomed.md",
				state: "proposed",
				attributes: { path: "doomed.md" },
			});

			await agent.resolve("rm_accept", {
				path: proposalPath,
				action: "accept",
			});

			const gone = await entries.getBody(runId, "doomed.md");
			assert.strictEqual(gone, null, "entry removed");

			await assert.rejects(
				fs.readFile(join(projectRoot, "doomed.md"), "utf8"),
				{ code: "ENOENT" },
				"file unlinked from disk",
			);
		});
	});

	describe("mv proposal accept", () => {
		it("removes source entry when isMove attribute is set", async () => {
			const { runId } = await seedProject(tdb, "mv_accept");
			await entries.set({
				runId,
				turn: 1,
				path: "known://source",
				body: "content",
				state: "resolved",
			});
			const proposalPath = await entries.logPath(runId, 1, "mv", "known://dest");
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "moved",
				state: "proposed",
				attributes: { from: "known://source", isMove: true },
			});

			await agent.resolve("mv_accept", {
				path: proposalPath,
				action: "accept",
			});

			const gone = await entries.getBody(runId, "known://source");
			assert.strictEqual(gone, null, "source entry removed on mv accept");
		});
	});

	describe("ask_user proposal accept", () => {
		it("stores user output as `answer` attribute on the entry", async () => {
			const { runId } = await seedProject(tdb, "ask_user_accept");
			const proposalPath = await entries.logPath(
				runId,
				1,
				"ask_user",
				"pick one",
			);
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "pick one",
				state: "proposed",
				attributes: { question: "pick one", options: ["a", "b"] },
			});

			await agent.resolve("ask_user_accept", {
				path: proposalPath,
				action: "accept",
				output: "a",
			});

			const attrs = await entries.getAttributes(runId, proposalPath);
			assert.strictEqual(
				attrs.answer,
				"a",
				"answer stored in attributes on accept",
			);
		});
	});

	describe("sh proposal accept", () => {
		it("seeds _1 and _2 companion data entries at state=streaming", async () => {
			const { runId } = await seedProject(tdb, "sh_accept");
			const proposalPath = await entries.logPath(runId, 1, "sh", "echo hi");
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "",
				state: "proposed",
				attributes: { command: "echo hi", summary: "echo hi" },
			});

			await agent.resolve("sh_accept", {
				path: proposalPath,
				action: "accept",
			});

			for (const ch of [1, 2]) {
				const chPath = `${proposalPath}_${ch}`;
				const body = await entries.getBody(runId, chPath);
				assert.strictEqual(
					body,
					"",
					`channel ${ch} seeded with empty body for streaming`,
				);
				const state = await entries.getState(runId, chPath);
				assert.strictEqual(
					state.state,
					"streaming",
					`channel ${ch} in streaming state`,
				);
			}
		});
	});

	describe("proposal reject", () => {
		it("flips proposal to state=failed with outcome=permission", async () => {
			const { runId } = await seedProject(tdb, "rejected");
			const proposalPath = await entries.logPath(runId, 1, "set", "nope.md");
			await entries.set({
				runId,
				turn: 1,
				path: proposalPath,
				body: "never",
				state: "proposed",
				attributes: { path: "nope.md" },
			});

			await agent.resolve("rejected", {
				path: proposalPath,
				action: "reject",
				output: "user said no",
			});

			const state = await entries.getState(runId, proposalPath);
			assert.strictEqual(state.state, "failed");
			assert.strictEqual(state.outcome, "permission");
		});
	});
});
