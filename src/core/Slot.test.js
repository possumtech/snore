import assert from "node:assert";
import { describe, it } from "node:test";
import Slot from "./Slot.js";

describe("Slot", () => {
	it("should sort fragments by priority", () => {
		const slot = new Slot();
		slot.add("second", 20);
		slot.add("first", 10);
		slot.add("third", 30);

		assert.strictEqual(slot.toString(), "first\nsecond\nthird");
	});

	it("should handle object content for files", () => {
		const slot = new Slot();
		slot.add({ path: "file.js", content: "code", status: "active" }, 10);

		const xml = slot.serializeFiles();
		assert.ok(/<file path="file.js" status="active">/.test(xml));
		assert.ok(/code/.test(xml));
	});

	it("should filter out empty fragments", () => {
		const slot = new Slot();
		slot.add("", 10);
		slot.add("content", 20);
		assert.strictEqual(slot.toString(), "content");
	});
});
