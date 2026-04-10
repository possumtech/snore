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

	it("summary returns command", () => {
		assert.strictEqual(plugin.summary({ attributes: { command: "ls" } }), "ls");
	});
});
