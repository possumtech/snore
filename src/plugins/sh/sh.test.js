import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Sh from "./sh.js";

describe("Sh", () => {
	const plugin = new Sh({
		registerScheme() {},
		on() {},
		filter() {},
	});

	it("full renders command and body", () => {
		const result = plugin.full({
			attributes: { command: "ls -la" },
			body: "file1\nfile2",
		});
		assert.ok(result.includes("ls -la"));
		assert.ok(result.includes("file1"));
	});

	it("summary returns empty for empty body", () => {
		assert.strictEqual(plugin.summary({ attributes: {}, body: "" }), "");
	});

	it("summary inlines short body verbatim with header", () => {
		const out = plugin.summary({
			attributes: { command: "ls -la", channel: 1 },
			body: "file1\nfile2\n",
		});
		assert.match(out, /^# sh ls -la \(stdout, 2L\)\n/);
		assert.ok(out.endsWith("file1\nfile2\n"));
	});

	it("summary keeps last 12 lines and reports range", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
		const out = plugin.summary({
			attributes: { command: "rg foo", channel: 1 },
			body: `${lines.join("\n")}\n`,
		});
		assert.match(out, /tail L39-50\/50/);
		assert.ok(out.includes("line50"));
		assert.ok(out.includes("line39"));
		assert.ok(!out.includes("line38"));
	});
});
