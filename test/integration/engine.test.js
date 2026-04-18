import assert from "node:assert";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import KnownStore from "../../src/agent/KnownStore.js";
import materialize from "../helpers/materialize.js";

const _pluginsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../src/plugins",
);

import TestDb from "../helpers/TestDb.js";

let RUN_ID;
let _PROJECT;

function pad(n) {
	return Array(n).fill("hello").join(" ");
}

describe("Engine integration", () => {
	let tdb;
	let store;

	before(async () => {
		tdb = await TestDb.create();
		store = new KnownStore(tdb.db);
		const seed = await tdb.seedRun({ alias: "engine_1" });
		RUN_ID = seed.runId;
		_PROJECT = { id: seed.projectId, project_root: "/tmp/test", name: "Test" };
	});

	beforeEach(async () => {
		await store.deleteByPattern(RUN_ID, "*", null);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("context materialization", () => {
		it("materializes entries into turn_context", async () => {
			await store.upsert(RUN_ID, 1, "src/small.js", pad(100), "resolved");
			await store.upsert(RUN_ID, 1, "known://note", "short", "resolved");

			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 1,
				systemPrompt: "test system prompt",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 1,
			});
			assert.ok(rows.length > 0, "turn_context should have entries");
			const file = rows.find((r) => r.path === "src/small.js");
			assert.ok(file, "file should be in turn_context");
		});

		it("includes system prompt as first entry", async () => {
			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 1,
				systemPrompt: "test system prompt",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 1,
			});
			const system = rows.find((r) => r.path === "system://prompt");
			assert.ok(system, "system prompt should be in turn_context");
			assert.strictEqual(
				system.ordinal,
				0,
				"system prompt should be ordinal 0",
			);
			assert.ok(
				system.body.includes("test system prompt"),
				"system prompt body should match",
			);
		});
	});

	describe("tokens accounting", () => {
		it("tokens unchanged through demote and promote cycle", async () => {
			await store.upsert(RUN_ID, 1, "known://test_entry", pad(200), "resolved");

			const original = await store.getEntriesByPattern(
				RUN_ID,
				"known://test_entry",
				null,
			);
			const originalTokens = original[0].tokens;
			assert.ok(originalTokens > 0, "tokens set on creation");

			await store.demote(RUN_ID, "known://test_entry");
			const demoted = await store.getEntriesByPattern(
				RUN_ID,
				"known://test_entry",
				null,
			);
			assert.strictEqual(
				demoted[0].tokens,
				originalTokens,
				"tokens unchanged after demote",
			);

			await store.promote(RUN_ID, "known://test_entry", 3);
			const promoted = await store.getEntriesByPattern(
				RUN_ID,
				"known://test_entry",
				null,
			);
			assert.strictEqual(
				promoted[0].tokens,
				originalTokens,
				"tokens unchanged after promote",
			);
		});
	});

	describe("symbol file fidelity via VIEW", () => {
		it("files at summary fidelity appear in turn_context", async () => {
			await store.upsert(RUN_ID, 1, "src/demoted.js", pad(100), "resolved", {
				fidelity: "demoted",
				attributes: { symbols: "function foo()" },
			});

			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 1,
				systemPrompt: "test system prompt",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 1,
			});
			const demoted = rows.find((r) => r.path === "src/demoted.js");
			assert.ok(demoted, "demoted file should appear in turn_context");
			assert.strictEqual(
				demoted.fidelity,
				"demoted",
				"demoted fidelity should be preserved",
			);
		});

		it("demoted files have demoted fidelity with body passed through (engine symbol view)", async () => {
			await store.upsert(
				RUN_ID,
				3,
				"src/active.js",
				"function bar() {}",
				"resolved",
				{
					fidelity: "demoted",
				},
			);

			await materialize(tdb.db, {
				runId: RUN_ID,
				turn: 4,
				systemPrompt: "test system prompt",
			});

			const rows = await tdb.db.get_turn_context.all({
				run_id: RUN_ID,
				turn: 4,
			});
			const active = rows.find((r) => r.path === "src/active.js");
			assert.ok(active, "demoted file should appear in turn_context");
			assert.strictEqual(
				active.fidelity,
				"demoted",
				"demoted fidelity preserved",
			);
			assert.ok(
				active.body.includes("function bar()"),
				"engine plugin's symbol view shows body at demoted fidelity",
			);
		});

		it("promoted view returns body", async () => {
			await store.upsert(
				RUN_ID,
				5,
				"src/described.js",
				"const x = 1;",
				"resolved",
				{
					fidelity: "promoted",
					attributes: { summary: "Utility module for X" },
				},
			);

			const viewResult = await tdb.hooks.tools.view("file", {
				path: "src/described.js",
				scheme: null,
				body: "const x = 1;",
				fidelity: "promoted",
				attributes: { summary: "Utility module for X" },
				category: "data",
			});
			assert.ok(
				viewResult.includes("const x = 1;"),
				"promoted view should include body",
			);
		});

		it("demoted view returns empty body (tag attribute carries summary)", async () => {
			await store.upsert(
				RUN_ID,
				6,
				"src/noview.js",
				"const y = 2;",
				"resolved",
				{
					fidelity: "demoted",
					attributes: { summary: "Helper for Y calculations" },
				},
			);

			const viewResult = await tdb.hooks.tools.view("file", {
				path: "src/noview.js",
				scheme: null,
				body: "const y = 2;",
				fidelity: "demoted",
				attributes: { summary: "Helper for Y calculations" },
				category: "data",
			});
			assert.strictEqual(
				viewResult,
				"",
				"file plugin returns empty at demoted fidelity — renderer wraps with summary attr",
			);
		});
	});
});
