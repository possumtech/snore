import assert from "node:assert/strict";
import { describe, it } from "node:test";
import File from "./file.js";

describe("File", () => {
	const plugin = new File({
		registerScheme() {},
		on() {},
		hooks: { tools: { onView() {} } },
	});

	it("full returns entry body", () => {
		assert.strictEqual(plugin.full({ body: "const x = 1;" }), "const x = 1;");
	});

	it("summary returns entry body", () => {
		assert.strictEqual(
			plugin.summary({ body: "summary text" }),
			"summary text",
		);
	});
});
