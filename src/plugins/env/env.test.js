import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Env from "./env.js";

describe("Env", () => {
	const plugin = new Env({
		registerScheme() {},
		on() {},
		filter() {},
	});

	it("full renders command and body", () => {
		const result = plugin.full({
			attributes: { command: "node --version" },
			body: "v25.8.1",
		});
		assert.ok(result.includes("node --version"));
		assert.ok(result.includes("v25.8.1"));
	});

	it("summary returns empty for empty body", () => {
		assert.strictEqual(plugin.summary({ attributes: {}, body: "" }), "");
	});

	it("summary inlines short body verbatim with header", () => {
		const out = plugin.summary({
			attributes: { command: "ls -F", channel: 1 },
			body: "a.out*\nhi.c\n",
		});
		assert.match(out, /^# env ls -F \(stdout, 2L\)\n/);
		assert.ok(out.endsWith("a.out*\nhi.c\n"));
	});

	it("summary keeps last 12 lines and reports range", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
		const out = plugin.summary({
			attributes: { command: "find /", channel: 1 },
			body: `${lines.join("\n")}\n`,
		});
		assert.match(out, /tail L39-50\/50/);
		assert.ok(out.includes("line50"));
		assert.ok(out.includes("line39"));
		assert.ok(!out.includes("line38"));
	});

	it("summary labels stderr channel", () => {
		const out = plugin.summary({
			attributes: { command: "ls", channel: 2 },
			body: "permission denied\n",
		});
		assert.ok(out.startsWith("# env ls (stderr,"));
	});
});
