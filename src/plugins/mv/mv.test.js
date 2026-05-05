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

	it("schemed → bare-path: creates a proposal (not auto-resolved)", async () => {
		// mv from known://draft to a file path is high-blast-radius (writes
		// to disk on accept). Must route through proposal lifecycle so the
		// client can accept/reject — never auto-resolve.
		const upserted = [];
		const store = {
			getBody: async (_r, p) =>
				p === "known://draft" ? "draft body content" : null,
			set: async (args) => upserted.push(args),
			rm: async () => {
				throw new Error("schemed→bare-path mv must not rm before accept");
			},
		};
		const rummy = { entries: store, sequence: 5, runId: 1, loopId: 1 };
		const entry = {
			attributes: { path: "known://draft", to: "deliverable.md" },
			resultPath: "log://turn_5/mv/known___draft",
		};
		await plugin.handler(entry, rummy);

		const log = upserted.find((u) => u.path === entry.resultPath);
		assert.ok(log, "result log entry written");
		assert.equal(log.state, "proposed", "state is proposed, not resolved");
		assert.equal(log.attributes.from, "known://draft");
		assert.equal(log.attributes.to, "deliverable.md");
		assert.equal(log.attributes.isMove, true);
	});

	it("schemed → schemed: auto-resolves (entry-to-entry, no proposal)", async () => {
		// Schema-to-schema mv stays in entry-space — no disk write, no
		// proposal. Resolve immediately.
		const upserted = [];
		const removed = [];
		const store = {
			getBody: async (_r, p) => (p === "known://draft" ? "draft body" : null),
			set: async (args) => upserted.push(args),
			rm: async (args) => removed.push(args),
		};
		const rummy = { entries: store, sequence: 5, runId: 1, loopId: 1 };
		const entry = {
			attributes: { path: "known://draft", to: "known://final" },
			resultPath: "log://turn_5/mv/known___draft",
		};
		await plugin.handler(entry, rummy);

		const dest = upserted.find((u) => u.path === "known://final");
		assert.ok(dest, "destination entry written");
		assert.equal(dest.body, "draft body");
		assert.equal(dest.state, "resolved");
		assert.ok(
			removed.some((r) => r.path === "known://draft"),
			"source entry removed",
		);
		const log = upserted.find((u) => u.path === entry.resultPath);
		assert.equal(log.state, "resolved");
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
