import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMarkerBody } from "./marker.js";

describe("parseMarkerBody — keyword operations", () => {
	it("plain body (no markers) returns null ops", () => {
		const r = parseMarkerBody("just a plain body without any markers");
		assert.equal(r.ops, null);
		assert.equal(r.error, null);
	});

	it("NEW: bracketed multi-line", () => {
		const r = parseMarkerBody("<<:::NEW\nfile contents\n:::NEW");
		assert.deepEqual(r.ops, [{ op: "new", content: "file contents" }]);
	});

	it("APPEND: single-line newline-tolerant", () => {
		const r = parseMarkerBody("<<:::APPEND extra :::APPEND");
		assert.deepEqual(r.ops, [{ op: "append", content: " extra " }]);
	});

	it("PREPEND: prepends content", () => {
		const r = parseMarkerBody("<<:::PREPEND\nheader\n:::PREPEND");
		assert.deepEqual(r.ops, [{ op: "prepend", content: "header" }]);
	});

	it("REPLACE: standalone full-body replace", () => {
		const r = parseMarkerBody("<<:::REPLACE\nnew body\n:::REPLACE");
		assert.deepEqual(r.ops, [{ op: "replace", content: "new body" }]);
	});

	it("DELETE: removes content", () => {
		const r = parseMarkerBody("<<:::DELETE\ndead code\n:::DELETE");
		assert.deepEqual(r.ops, [{ op: "delete", content: "dead code" }]);
	});

	it("SEARCH/REPLACE pair → single search_replace op", () => {
		const body = [
			"<<:::SEARCH",
			"old line",
			":::SEARCH<<:::REPLACE",
			"new line",
			":::REPLACE",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{ op: "search_replace", search: "old line", replace: "new line" },
		]);
	});

	it("multiple SEARCH/REPLACE pairs apply in order", () => {
		const body = [
			"<<:::SEARCH",
			"a",
			":::SEARCH<<:::REPLACE",
			"A",
			":::REPLACE",
			"",
			"<<:::SEARCH",
			"b",
			":::SEARCH<<:::REPLACE",
			"B",
			":::REPLACE",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.equal(r.ops.length, 2);
		assert.equal(r.ops[0].op, "search_replace");
		assert.equal(r.ops[0].search, "a");
		assert.equal(r.ops[0].replace, "A");
		assert.equal(r.ops[1].search, "b");
	});

	it("mixed ops in one body apply in order", () => {
		const body = [
			"<<:::APPEND tail :::APPEND",
			"<<:::PREPEND head :::PREPEND",
		].join("");
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{ op: "append", content: " tail " },
			{ op: "prepend", content: " head " },
		]);
	});

	it("keyword + alphanumeric suffix routes to keyword op (nesting disambiguator)", () => {
		// <<:::SEARCH1 ... :::SEARCH1 — same op as SEARCH; suffix only lets
		// outer/inner markers coexist.
		const body = [
			"<<:::SEARCH1",
			"old",
			":::SEARCH1<<:::REPLACE1",
			"new",
			":::REPLACE1",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{ op: "search_replace", search: "old", replace: "new" },
		]);
	});
});

describe("parseMarkerBody — non-keyword IDENT routes to REPLACE", () => {
	it("path-flavored IDENT (e.g. OC_RIVERS.md mirroring packet rendering)", () => {
		// Models see <<:::OC_RIVERS.md ::: OC_RIVERS.md in their context
		// and may mimic. Treat as REPLACE with the inner content.
		const body = "<<:::OC_RIVERS.md\nfull file\n:::OC_RIVERS.md";
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [{ op: "replace", content: "full file" }]);
	});

	it("identifier-flavored IDENT", () => {
		const r = parseMarkerBody("<<:::EOF\ncontent\n:::EOF");
		assert.deepEqual(r.ops, [{ op: "replace", content: "content" }]);
	});

	it("hyphenated IDENT (e.g. file paths with dashes)", () => {
		const r = parseMarkerBody("<<:::project-spec\ndoc body\n:::project-spec");
		assert.deepEqual(r.ops, [{ op: "replace", content: "doc body" }]);
	});
});

describe("parseMarkerBody — errors", () => {
	it("lone SEARCH (no following REPLACE) → parse error", () => {
		const body = "<<:::SEARCH\nold\n:::SEARCH";
		const r = parseMarkerBody(body);
		assert.equal(r.ops, null);
		assert.match(r.error, /SEARCH must be immediately followed by REPLACE/);
	});

	it("SEARCH followed by non-REPLACE op → parse error", () => {
		const body = ["<<:::SEARCH\na\n:::SEARCH", "<<:::APPEND b :::APPEND"].join(
			"",
		);
		const r = parseMarkerBody(body);
		assert.equal(r.ops, null);
		assert.match(r.error, /SEARCH must be immediately followed by REPLACE/);
	});

	it("unclosed marker → parse error names the IDENT", () => {
		const body = "<<:::APPEND content but no closer";
		const r = parseMarkerBody(body);
		assert.equal(r.ops, null);
		assert.match(r.error, /unclosed.*APPEND/);
	});
});

describe("parseMarkerBody — nesting via IDENT suffix", () => {
	it("inner markers with different IDENT survive as content of outer", () => {
		// Outer SEARCH_OUTER wraps an inner literal that itself contains
		// SEARCH/REPLACE markers — only the outer matched IDENT closes.
		const body = [
			"<<:::SEARCH_OUTER",
			"<<:::SEARCH",
			"inner old",
			":::SEARCH<<:::REPLACE",
			"inner new",
			":::REPLACE",
			":::SEARCH_OUTER<<:::REPLACE_OUTER",
			"replacement",
			":::REPLACE_OUTER",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{
				op: "search_replace",
				search: [
					"<<:::SEARCH",
					"inner old",
					":::SEARCH<<:::REPLACE",
					"inner new",
					":::REPLACE",
				].join("\n"),
				replace: "replacement",
			},
		]);
	});
});
