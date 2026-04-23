/**
 * SQL function integration tests.
 *
 * Covers @sql_functions — the user-defined functions registered at
 * open time. Tested through the contracts that depend on them:
 *
 * - `schemeOf(path)` powers the `entries.scheme` generated column.
 *   If it's unregistered or broken, `scheme` is wrong.
 * - `countTokens(text)` is used in prepared statements that compute
 *   token budgets. If it's unregistered, those preps crash at runtime.
 * - `slugify(text)` is used by `Entries.slugPath` for URL-safe path
 *   construction. Tested via a write that exercises the helper.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("SQL functions (@sql_functions)", () => {
	let tdb;
	let store;
	let RUN_ID;

	before(async () => {
		tdb = await TestDb.create("sql_functions");
		store = new Entries(tdb.db);
		const seed = await tdb.seedRun({ alias: "sql_fns" });
		RUN_ID = seed.runId;
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("schemeOf(path) drives entries.scheme", () => {
		it("URI paths get their scheme extracted into the generated column", async () => {
			const cases = [
				["known://k", "known"],
				["http://example.com", "http"],
				["https://example.com", "https"],
			];
			for (const [path, expected] of cases) {
				await store.set({
					runId: RUN_ID,
					turn: 1,
					path,
					body: "x",
					state: "resolved",
				});
			}
			const rows = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			for (const [path, expected] of cases) {
				const row = rows.find((r) => r.path === path);
				assert.ok(row, `entry ${path} stored`);
				assert.strictEqual(
					row.scheme,
					expected,
					`schemeOf(${path}) = ${expected}`,
				);
			}
		});

		it("bare file paths have NULL scheme (the 'file' case)", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "src/app.js",
				body: "const x = 1;",
				state: "resolved",
			});
			const rows = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const row = rows.find((r) => r.path === "src/app.js");
			assert.ok(row, "bare-path entry stored");
			assert.strictEqual(row.scheme, null, "schemeOf returns NULL");
		});
	});

	describe("countTokens(text) drives entries.tokens", () => {
		it("tokens column reflects body size via countTokens", async () => {
			const divisor = Number(process.env.RUMMY_TOKEN_DIVISOR);
			const body = "x".repeat(divisor * 5);
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "known://tokens_probe",
				body,
				state: "resolved",
			});
			const rows = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const row = rows.find((r) => r.path === "known://tokens_probe");
			assert.ok(row, "entry stored");
			assert.strictEqual(
				row.tokens,
				5,
				`body of ${body.length} chars = ${5} tokens with divisor ${divisor}`,
			);
		});

		it("empty body yields 0 tokens", async () => {
			await store.set({
				runId: RUN_ID,
				turn: 1,
				path: "known://empty_tokens",
				body: "",
				state: "resolved",
			});
			const rows = await tdb.db.get_known_entries.all({ run_id: RUN_ID });
			const row = rows.find((r) => r.path === "known://empty_tokens");
			assert.strictEqual(row.tokens, 0);
		});
	});
});
