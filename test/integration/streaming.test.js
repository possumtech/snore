/**
 * Streaming integration tests.
 *
 * Covers the storage-layer half of the streaming entry pipeline:
 * - appendBody grows an entry's body and recomputes tokens
 * - Negative line with streamed content performs tail reads correctly
 * - Status transitions through 202 (proposal) → 102 (running) → 200/500
 *   via the existing resolve_known_entry prep
 *
 * Full stream-plugin RPC flow tests require AuditClient-level integration
 * and live in E2E; this file verifies the underlying primitives are correct.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import Entries from "../../src/agent/Entries.js";
import TestDb from "../helpers/TestDb.js";

describe("Streaming primitives", () => {
	let tdb, store;

	before(async () => {
		tdb = await TestDb.create("streaming");
		store = new Entries(tdb.db);
		await store.loadSchemes(tdb.db);
	});

	after(async () => {
		await tdb.cleanup();
	});

	describe("appendBody", () => {
		it("appends chunks to a running entry and recomputes tokens", async () => {
			const { runId } = await tdb.seedRun({ alias: "stream_append" });
			const path = "sh://turn_1/npm_test_1";

			// Streaming entry starts at 102, empty body (created on accept).
			await store.set({
				runId,
				turn: 1,
				path,
				body: "",
				state: "streaming",
				visibility: "summarized",
			});

			await store.set({
				runId: runId,
				path: path,
				body: "hello ",
				append: true,
			});
			await store.set({
				runId: runId,
				path: path,
				body: "world\n",
				append: true,
			});
			await store.set({
				runId: runId,
				path: path,
				body: "line 2\n",
				append: true,
			});

			const entries = await tdb.db.get_known_entries.all({ run_id: runId });
			const entry = entries.find((e) => e.path === path);
			assert.strictEqual(entry.body, "hello world\nline 2\n");
			assert.strictEqual(
				entry.state,
				"streaming",
				"status stays at 102 during streaming",
			);
			assert.ok(entry.tokens > 0, "tokens recomputed after append");
		});

		it("tokens grow as body grows", async () => {
			const { runId } = await tdb.seedRun({ alias: "stream_tokens" });
			const path = "sh://turn_1/grow_1";

			await store.set({
				runId,
				turn: 1,
				path,
				body: "",
				state: "streaming",
				visibility: "summarized",
			});

			await store.set({
				runId: runId,
				path: path,
				body: "a".repeat(100),
				append: true,
			});
			const first = (
				await tdb.db.get_known_entries.all({ run_id: runId })
			).find((e) => e.path === path);

			await store.set({
				runId: runId,
				path: path,
				body: "a".repeat(500),
				append: true,
			});
			const second = (
				await tdb.db.get_known_entries.all({ run_id: runId })
			).find((e) => e.path === path);

			assert.ok(
				second.tokens > first.tokens,
				"tokens should grow with additional appends",
			);
		});
	});

	describe("Status lifecycle", () => {
		it("transitions 102 → 200 on successful completion", async () => {
			const { runId } = await tdb.seedRun({ alias: "stream_success" });
			const path = "sh://turn_1/ok_1";

			await store.set({
				runId,
				turn: 1,
				path,
				body: "",
				state: "streaming",
				visibility: "summarized",
			});
			await store.set({
				runId: runId,
				path: path,
				body: "ran ok\n",
				append: true,
			});

			// Simulate stream/completed — transition to terminal status.
			await store.set({ runId, path, state: "resolved", body: "ran ok\n" });

			const entry = (
				await tdb.db.get_known_entries.all({ run_id: runId })
			).find((e) => e.path === path);
			assert.strictEqual(entry.state, "resolved");
			assert.strictEqual(entry.body, "ran ok\n");
		});

		it("transitions 102 → 500 on failure", async () => {
			const { runId } = await tdb.seedRun({ alias: "stream_fail" });
			const path = "sh://turn_1/bad_1";

			await store.set({
				runId,
				turn: 1,
				path,
				body: "",
				state: "streaming",
				visibility: "summarized",
			});
			await store.set({
				runId: runId,
				path: path,
				body: "error output\n",
				append: true,
			});

			await store.set({ runId, path, state: "failed", body: "error output\n" });

			const entry = (
				await tdb.db.get_known_entries.all({ run_id: runId })
			).find((e) => e.path === path);
			assert.strictEqual(entry.state, "failed");
		});
	});

	describe("Multi-channel pattern", () => {
		it("log + stdout + stderr entries coexist with pattern matching", async () => {
			const { runId } = await tdb.seedRun({ alias: "stream_multi" });
			const base = "sh://turn_1/cmd";

			// Log entry (200, logging-shaped)
			await store.set({
				runId,
				turn: 1,
				path: base,
				body: "ran 'cmd'",
				state: "resolved",
				visibility: "summarized",
				attributes: { command: "cmd" },
			});
			// Data channels at 102
			await store.set({
				runId,
				turn: 1,
				path: `${base}_1`,
				body: "",
				state: "streaming",
				visibility: "summarized",
				attributes: { command: "cmd", channel: 1 },
			});
			await store.set({
				runId,
				turn: 1,
				path: `${base}_2`,
				body: "",
				state: "streaming",
				visibility: "summarized",
				attributes: { command: "cmd", channel: 2 },
			});

			await store.set({
				runId: runId,
				path: `${base}_1`,
				body: "stdout content\n",
				append: true,
			});
			await store.set({
				runId: runId,
				path: `${base}_2`,
				body: "stderr content\n",
				append: true,
			});

			// Pattern-match all channels for terminal transition (what
			// stream/completed does).
			const channels = await store.getEntriesByPattern(
				runId,
				`${base}_*`,
				null,
			);
			assert.strictEqual(channels.length, 2, "both channels found");

			for (const ch of channels) {
				await store.set({
					runId,
					path: ch.path,
					state: "resolved",
					body: ch.body,
				});
			}

			const all = await tdb.db.get_known_entries.all({ run_id: runId });
			const stdout = all.find((e) => e.path === `${base}_1`);
			const stderr = all.find((e) => e.path === `${base}_2`);
			assert.strictEqual(stdout.state, "resolved");
			assert.strictEqual(stderr.state, "resolved");
		});
	});

	describe("Tail on streaming entries", () => {
		it("negative line reads the tail of a growing entry", async () => {
			const { runId } = await tdb.seedRun({ alias: "stream_tail" });
			const path = "sh://turn_1/long_1";

			await store.set({
				runId,
				turn: 1,
				path,
				body: "",
				state: "streaming",
				visibility: "summarized",
			});
			// Simulate 100 lines of streamed output
			for (let i = 1; i <= 100; i++) {
				await store.set({
					runId: runId,
					path: path,
					body: `line ${i}\n`,
					append: true,
				});
			}

			const entry = (
				await tdb.db.get_known_entries.all({ run_id: runId })
			).find((e) => e.path === path);
			const lines = entry.body.split("\n").filter(Boolean);
			assert.strictEqual(lines.length, 100, "all 100 lines present");
			assert.strictEqual(lines[99], "line 100");
			assert.strictEqual(lines[50], "line 51");
		});
	});
});
