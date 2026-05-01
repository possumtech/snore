import assert from "node:assert/strict";
import { describe, it } from "node:test";
import doc from "./setDoc.js";

describe("setDoc", () => {
	it("exports the loaded markdown as a non-empty trimmed string", () => {
		assert.equal(typeof doc, "string");
		assert.ok(doc.length > 0);
		assert.equal(doc, doc.trim());
	});
});
