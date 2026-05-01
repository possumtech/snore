import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	loadDoc,
	logPathToDataBase,
	storePatternResult,
	streamSummary,
} from "./helpers.js";

describe("loadDoc", () => {
	it("reads a sibling .md and returns trimmed contents", () => {
		// Use a known sibling tooldoc: get/getDoc.md exists.
		const metaUrl = new URL("./get/getDoc.js", import.meta.url).href;
		const body = loadDoc(metaUrl, "getDoc.md");
		assert.equal(typeof body, "string");
		assert.ok(body.length > 0);
		// .replace strips HTML comments — body should contain no <!-- markers.
		assert.doesNotMatch(body, /<!--/);
	});

	it("collapses 3+ consecutive newlines down to 2", () => {
		// We'll reuse loadDoc with the actual file; assert it never has
		// 3+ consecutive newlines.
		const metaUrl = new URL("./get/getDoc.js", import.meta.url).href;
		const body = loadDoc(metaUrl, "getDoc.md");
		assert.doesNotMatch(body, /\n{3,}/);
	});

	it("trims leading/trailing whitespace", () => {
		const metaUrl = new URL("./get/getDoc.js", import.meta.url).href;
		const body = loadDoc(metaUrl, "getDoc.md");
		assert.equal(body, body.trim());
	});
});

describe("logPathToDataBase", () => {
	it("returns null for nullish input", () => {
		assert.equal(logPathToDataBase(null), null);
		assert.equal(logPathToDataBase(undefined), null);
	});

	it("returns null for non-log paths", () => {
		assert.equal(logPathToDataBase("known://x"), null);
		assert.equal(logPathToDataBase("src/app.js"), null);
		assert.equal(logPathToDataBase("log://no-turn"), null);
	});

	it("transforms log://turn_N/{action}/{rest} → {action}://turn_N/{rest}", () => {
		assert.equal(
			logPathToDataBase("log://turn_3/sh/echo_hello"),
			"sh://turn_3/echo_hello",
		);
		assert.equal(
			logPathToDataBase("log://turn_42/env/ls_-la"),
			"env://turn_42/ls_-la",
		);
	});

	it("preserves the rest including extra slashes", () => {
		assert.equal(
			logPathToDataBase("log://turn_1/get/known%3A//foo"),
			"get://turn_1/known%3A//foo",
		);
	});
});

describe("streamSummary", () => {
	it("returns empty string when entry body is empty", () => {
		assert.equal(streamSummary("env", { body: "", attributes: {} }), "");
		assert.equal(streamSummary("env", { body: null, attributes: {} }), "");
	});

	it("renders full body when total lines <= tail limit", () => {
		const entry = {
			body: "line1\nline2\nline3",
			attributes: { command: "ls", channel: 1 },
		};
		const out = streamSummary("env", entry, 12);
		assert.match(out, /^# env ls \(stdout, 3L\)\nline1\nline2\nline3$/);
	});

	it("identifies stderr (channel=2) vs stdout in header", () => {
		const entry = {
			body: "err\n",
			attributes: { command: "x", channel: 2 },
		};
		const out = streamSummary("sh", entry);
		assert.match(out, /\(stderr, /);
	});

	it("tail-truncates when total lines exceed limit, includes range header", () => {
		const lines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n");
		const entry = {
			body: lines,
			attributes: { command: "ls", channel: 1 },
		};
		const out = streamSummary("env", entry, 5);
		// Header should mention tail L26-30/30 + the get-line hint.
		assert.match(out, /tail L26-30\/30/);
		assert.match(out, /<get line="1"/);
		// Last 5 lines present in body.
		for (const i of [26, 27, 28, 29, 30]) {
			assert.match(out, new RegExp(`L${i}`));
		}
		// Earlier lines absent.
		for (const i of [1, 5, 25]) {
			assert.doesNotMatch(out, new RegExp(`L${i}\\n`));
		}
	});

	it("preserves trailing newline in tail when body had one", () => {
		const lines = `${Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n")}\n`;
		const entry = {
			body: lines,
			attributes: { command: "x", channel: 1 },
		};
		const out = streamSummary("env", entry, 5);
		assert.ok(out.endsWith("L30\n"));
	});
});

describe("storePatternResult", () => {
	it("writes a log entry with manifest header (when manifest=true)", async () => {
		const writes = [];
		const store = {
			async logPath(_runId, turn, scheme, path) {
				return `log://turn_${turn}/${scheme}/${path}`;
			},
			async set(args) {
				writes.push(args);
			},
		};
		await storePatternResult(
			store,
			1,
			3,
			"get",
			"src/**/*.js",
			null,
			[
				{ path: "src/a.js", tokens: 100 },
				{ path: "src/b.js", tokens: 200 },
			],
			{ manifest: true },
		);

		assert.equal(writes.length, 1);
		const w = writes[0];
		assert.equal(w.path, "log://turn_3/get/src/**/*.js");
		assert.match(
			w.body,
			/^MANIFEST get path="src\/\*\*\/\*\.js": 2 matched \(300 tokens\)/,
		);
		assert.match(w.body, /src\/a\.js \(100\)/);
		assert.match(w.body, /src\/b\.js \(200\)/);
		assert.equal(w.state, "resolved");
	});

	it("includes body filter in body text when bodyFilter provided", async () => {
		const writes = [];
		const store = {
			async logPath(_runId, turn, scheme, path) {
				return `log://turn_${turn}/${scheme}/${path}`;
			},
			async set(args) {
				writes.push(args);
			},
		};
		await storePatternResult(
			store,
			1,
			1,
			"get",
			"**",
			"keyword",
			[{ path: "x.js", tokens: 50 }],
			{},
		);
		assert.match(writes[0].body, /body="keyword"/);
	});

	it("forwards loopId and attributes", async () => {
		const writes = [];
		const store = {
			async logPath() {
				return "log://turn_1/get/x";
			},
			async set(args) {
				writes.push(args);
			},
		};
		await storePatternResult(store, 1, 1, "get", "x", null, [], {
			loopId: 7,
			attributes: { foo: "bar" },
		});
		assert.equal(writes[0].loopId, 7);
		assert.deepEqual(writes[0].attributes, { foo: "bar" });
	});
});
