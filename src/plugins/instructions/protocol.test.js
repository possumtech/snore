import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Protocol from "./protocol.js";

describe("Protocol plugin (placeholder pass-through)", () => {
	it("registers an entry.recording filter at priority 1", () => {
		const captured = [];
		const core = {
			filter(name, fn, priority) {
				captured.push({ name, fn, priority });
			},
		};
		new Protocol(core);
		assert.equal(captured.length, 1);
		assert.equal(captured[0].name, "entry.recording");
		assert.equal(captured[0].priority, 1);
		assert.equal(typeof captured[0].fn, "function");
	});

	it("filter returns the entry unchanged (current placeholder behavior)", async () => {
		let captured;
		const core = {
			filter(_name, fn) {
				captured = fn;
			},
		};
		new Protocol(core);
		const entry = { path: "x", scheme: "y", body: "z", state: "resolved" };
		const result = await captured(entry, {});
		assert.strictEqual(result, entry);
	});
});
