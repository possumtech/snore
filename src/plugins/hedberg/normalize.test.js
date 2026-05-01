import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJsonEdit } from "./normalize.js";

describe("parseJsonEdit", () => {
	it("returns null for non-brace input", () => {
		assert.equal(parseJsonEdit("foo"), null);
		assert.equal(parseJsonEdit('["search"]'), null);
	});

	it("returns null when 'search' substring absent", () => {
		assert.equal(parseJsonEdit("{}"), null);
		assert.equal(parseJsonEdit('{ "x": 1 }'), null);
	});

	it("parses canonical JSON form", () => {
		const out = parseJsonEdit('{"search":"old","replace":"new"}');
		assert.deepEqual(out, { search: "old", replace: "new" });
	});

	it("defaults replace to empty string when omitted", () => {
		const out = parseJsonEdit('{"search":"old"}');
		assert.deepEqual(out, { search: "old", replace: "" });
	});

	it("falls back to key=value form on JSON parse failure", () => {
		const out = parseJsonEdit('{search="old", replace="new"}');
		assert.deepEqual(out, { search: "old", replace: "new" });
	});

	it("key=value form: replace absent → empty string", () => {
		const out = parseJsonEdit('{search="lonely"}');
		assert.deepEqual(out, { search: "lonely", replace: "" });
	});

	it("returns null when neither parser path produces search", () => {
		// Has 'search' substring (gating check passes) but neither parser
		// can extract a value.
		const out = parseJsonEdit("{ search-without-quotes }");
		assert.equal(out, null);
	});

	it("trims surrounding whitespace before brace check", () => {
		const out = parseJsonEdit('  \n\t{"search":"x"}\n');
		assert.deepEqual(out, { search: "x", replace: "" });
	});

	it("ignores non-search keys in JSON form", () => {
		// search:null is treated as absent; falls through to fallback regex.
		const out = parseJsonEdit('{"search":null,"replace":"y"}');
		// Fallback regex won't match (no quoted search="..."), so null.
		assert.equal(out, null);
	});
});
