import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Rm from "./rm.js";

describe("Rm", () => {
	const plugin = new Rm({
		registerScheme() {},
		on() {},
		filter() {},
	});

	it("full renders rm path", () => {
		const result = plugin.full({
			attributes: { path: "known://old" },
			body: "",
		});
		assert.ok(result.includes("known://old"));
	});

	it("full lists removed paths when body is present", () => {
		const result = plugin.full({
			attributes: { path: "known://chunk_*" },
			body: "known://chunk_1\nknown://chunk_2\nknown://chunk_3",
		});
		assert.ok(result.includes("# rm known://chunk_*"));
		assert.ok(result.includes("known://chunk_1"));
		assert.ok(result.includes("known://chunk_2"));
		assert.ok(result.includes("known://chunk_3"));
	});

	it("summary returns empty — tag attributes carry the path", () => {
		assert.strictEqual(plugin.summary(), "");
	});

	it("manifest: lists matched paths without removing", async () => {
		const removed = [];
		const upserted = [];
		const matches = [
			{ path: "known://temp_a", scheme: "known", tokens: 100, body: "..." },
			{ path: "known://temp_b", scheme: "known", tokens: 50, body: "..." },
		];
		const store = {
			getEntriesByPattern: async () => matches,
			rm: async ({ path }) => removed.push(path),
			set: async ({ path, body, state }) =>
				upserted.push({ path, body, state }),
			logPath: async (_r, t, s, p) =>
				`log://turn_${t}/${s}/${encodeURIComponent(p)}`,
		};
		const rummy = {
			entries: store,
			sequence: 1,
			runId: 1,
			loopId: 1,
		};
		const entry = {
			attributes: { path: "known://temp_*", manifest: "" },
			resultPath: "rm://result",
		};
		await plugin.handler(entry, rummy);
		assert.equal(removed.length, 0, "manifest must not remove anything");
		const log = upserted.find((u) => u.path?.startsWith("log://"));
		assert.ok(log, "wrote a manifest log entry");
		assert.match(log.body, /^MANIFEST rm path="known:\/\/temp_\*": 2 matched/);
		assert.ok(log.body.includes("known://temp_a (100)"));
		assert.ok(log.body.includes("known://temp_b (50)"));
	});
});
