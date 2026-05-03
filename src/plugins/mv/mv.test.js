import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Mv from "./mv.js";

describe("Mv", () => {
	const plugin = new Mv({
		registerScheme() {},
		on() {},
		filter() {},
	});

	it("full renders mv from and to", () => {
		const result = plugin.full({ attributes: { from: "a", to: "b" } });
		assert.ok(result.includes("a"));
		assert.ok(result.includes("b"));
	});

	it("manifest: lists matched paths without moving or flipping visibility", async () => {
		const upserted = [];
		const matches = [
			{ path: "known://draft_1", scheme: "known", tokens: 200 },
			{ path: "known://draft_2", scheme: "known", tokens: 150 },
		];
		const store = {
			getEntriesByPattern: async () => matches,
			set: async (args) => upserted.push(args),
			rm: async () => {
				throw new Error("manifest must not rm");
			},
			getBody: async () => {
				throw new Error("manifest must not read source body");
			},
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
			attributes: {
				path: "known://draft_*",
				to: "known://archive_",
				manifest: "",
			},
			resultPath: "mv://result",
		};
		await plugin.handler(entry, rummy);
		const log = upserted.find((u) => u.path?.startsWith("log://"));
		assert.ok(log, "wrote a manifest log entry");
		assert.match(log.body, /^MANIFEST mv path="known:\/\/draft_\*": 2 matched/);
		assert.ok(log.body.includes("known://draft_1"));
		assert.ok(log.body.includes("known://draft_2"));
	});
});
