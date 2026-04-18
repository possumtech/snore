/**
 * Schema V2 invariants — constraint-level claims from SPEC §1.1 / §1.2
 * that the database layer enforces.
 *
 * Not covered here:
 * - "`known_entries` is a read-only VIEW" is a SQLite guarantee (views
 *   without INSTEAD OF triggers reject writes); the testable discipline
 *   is "no prep targets `known_entries` for writes" — a grep check,
 *   not a runtime test.
 * - Scope is free-form text by design (Phase D); narrowing would be
 *   a deliberate future change, not a current invariant to enforce.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import KnownStore from "../../src/agent/KnownStore.js";
import TestDb from "../helpers/TestDb.js";

describe("Schema V2 invariants", () => {
	let tdb;
	let store;

	before(async () => {
		tdb = await TestDb.create("schema_v2");
		store = new KnownStore(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("fidelity constraint", () => {
		it("accepts the three canonical values", async () => {
			const { runId } = await tdb.seedRun({ alias: "fid_accept" });
			for (const fidelity of ["promoted", "demoted", "archived"]) {
				await store.upsert(
					runId,
					1,
					`known://fid-${fidelity}`,
					"body",
					"resolved",
					{
						fidelity,
					},
				);
			}
			// No throw = accepted.
		});

		it("rejects stale fidelity vocabulary", async () => {
			const { runId } = await tdb.seedRun({ alias: "fid_reject" });
			for (const stale of ["full", "summary", "index", "archive"]) {
				await assert.rejects(
					store.upsert(runId, 1, `known://fid-${stale}`, "body", "resolved", {
						fidelity: stale,
					}),
					/constraint|CHECK|fidelity/i,
					`fidelity="${stale}" must be rejected`,
				);
			}
		});
	});

	describe("entries + run_views separation", () => {
		it("entries.scope defaults to 'run:<runId>' for default-scope schemes", async () => {
			const { runId } = await tdb.seedRun({ alias: "scope_default" });
			await store.upsert(runId, 1, "known://scoped", "content", "resolved", {
				writer: "model",
			});
			const all = await tdb.db.get_known_entries.all({ run_id: runId });
			const row = all.find((e) => e.path === "known://scoped");
			assert.ok(row, "entry visible via compat view");
			assert.strictEqual(row.scope, `run:${runId}`);
		});

		it("writing an entry creates one content row and one view row", async () => {
			const { runId: a } = await tdb.seedRun({ alias: "dup_a" });
			const { runId: b } = await tdb.seedRun({ alias: "dup_b" });
			await store.upsert(a, 1, "known://sharedpath", "A body", "resolved");
			await store.upsert(b, 1, "known://sharedpath", "B body", "resolved");

			// Two runs, two content rows (different scopes), two view rows.
			const aRows = await tdb.db.get_known_entries.all({ run_id: a });
			const bRows = await tdb.db.get_known_entries.all({ run_id: b });
			const aMatch = aRows.find((r) => r.path === "known://sharedpath");
			const bMatch = bRows.find((r) => r.path === "known://sharedpath");
			assert.strictEqual(aMatch.body, "A body");
			assert.strictEqual(bMatch.body, "B body");
			assert.notStrictEqual(
				aMatch.scope,
				bMatch.scope,
				"run-scoped entries live in separate scopes",
			);
		});
	});
});
