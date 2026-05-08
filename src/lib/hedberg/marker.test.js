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
		const r = parseMarkerBody("<<NEW\nfile contents\nNEW");
		assert.deepEqual(r.ops, [{ op: "new", content: "file contents" }]);
	});

	it("APPEND: single-line newline-tolerant", () => {
		const r = parseMarkerBody("<<APPEND extra APPEND");
		assert.deepEqual(r.ops, [{ op: "append", content: " extra " }]);
	});

	it("PREPEND: prepends content", () => {
		const r = parseMarkerBody("<<PREPEND\nheader\nPREPEND");
		assert.deepEqual(r.ops, [{ op: "prepend", content: "header" }]);
	});

	it("REPLACE: standalone full-body replace", () => {
		const r = parseMarkerBody("<<REPLACE\nnew body\nREPLACE");
		assert.deepEqual(r.ops, [{ op: "replace", content: "new body" }]);
	});

	it("DELETE: removes content", () => {
		const r = parseMarkerBody("<<DELETE\ndead code\nDELETE");
		assert.deepEqual(r.ops, [{ op: "delete", content: "dead code" }]);
	});

	it("SEARCH/REPLACE pair → single search_replace op (clean newline style)", () => {
		const body = [
			"<<SEARCH",
			"old line",
			"SEARCH",
			"<<REPLACE",
			"new line",
			"REPLACE",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{ op: "search_replace", search: "old line", replace: "new line" },
		]);
	});

	it("SEARCH/REPLACE pair with glued bridge (SEARCH<<REPLACE)", () => {
		const body = [
			"<<SEARCH",
			"old line",
			"SEARCH<<REPLACE",
			"new line",
			"REPLACE",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{ op: "search_replace", search: "old line", replace: "new line" },
		]);
	});

	it("multiple SEARCH/REPLACE pairs apply in order", () => {
		const body = [
			"<<SEARCH",
			"a",
			"SEARCH",
			"<<REPLACE",
			"A",
			"REPLACE",
			"",
			"<<SEARCH",
			"b",
			"SEARCH",
			"<<REPLACE",
			"B",
			"REPLACE",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.equal(r.ops.length, 2);
		assert.equal(r.ops[0].op, "search_replace");
		assert.equal(r.ops[0].search, "a");
		assert.equal(r.ops[0].replace, "A");
		assert.equal(r.ops[1].search, "b");
	});

	it("mixed ops in one body apply in order", () => {
		const body = "<<APPEND tail APPEND<<PREPEND head PREPEND";
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{ op: "append", content: " tail " },
			{ op: "prepend", content: " head " },
		]);
	});

	it("keyword + alphanumeric suffix routes to keyword op (nesting disambiguator)", () => {
		const body = [
			"<<SEARCH1",
			"old",
			"SEARCH1",
			"<<REPLACE1",
			"new",
			"REPLACE1",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{ op: "search_replace", search: "old", replace: "new" },
		]);
	});
});

describe("parseMarkerBody — non-keyword IDENT routes to REPLACE", () => {
	it("DOC IDENT: full-body replace with literal content", () => {
		const body = "<<DOC\nfull document body\nDOC";
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [{ op: "replace", content: "full document body" }]);
	});

	it("EOF IDENT (bash convention)", () => {
		const r = parseMarkerBody("<<EOF\ncontent\nEOF");
		assert.deepEqual(r.ops, [{ op: "replace", content: "content" }]);
	});

	it("body containing keyword literally — outer wraps it via custom IDENT", () => {
		const body = [
			"<<DOC",
			"The opener is <<SEARCH and the closer is bare SEARCH.",
			"DOC",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{
				op: "replace",
				content: "The opener is <<SEARCH and the closer is bare SEARCH.",
			},
		]);
	});
});

describe("parseMarkerBody — boundary anchoring", () => {
	it("mid-token `<<` does not false-trigger (vec<<SEARCH)", () => {
		const r = parseMarkerBody("vec<<SEARCH var SEARCH");
		assert.equal(r.ops, null);
		assert.equal(r.error, null);
	});

	it("lowercase IDENT does not trigger (`<<eof`)", () => {
		const r = parseMarkerBody("<<eof\ncontent\neof");
		assert.equal(r.ops, null);
		assert.equal(r.error, null);
	});

	it("packet-shape `<<:::IDENT` does not trigger edit syntax", () => {
		// Engine emits `<<:::path` for entry rendering (plugins/helpers.js).
		// Edit syntax is bare-only — packet shape falls through to
		// plain-body REPLACE with the markers preserved as literal
		// content. The two grammars stay distinct.
		const body = "<<:::OC_RIVERS.md\ncontent\n:::OC_RIVERS.md";
		const r = parseMarkerBody(body);
		assert.equal(r.ops, null);
		assert.equal(r.error, null);
	});
});

describe("parseMarkerBody — errors", () => {
	it("lone SEARCH (no following REPLACE) → parse error", () => {
		const body = "<<SEARCH\nold\nSEARCH";
		const r = parseMarkerBody(body);
		assert.equal(r.ops, null);
		assert.match(r.error, /lone SEARCH/);
	});

	it("SEARCH followed by non-REPLACE op → parse error", () => {
		const body = "<<SEARCH\na\nSEARCH<<APPEND b APPEND";
		const r = parseMarkerBody(body);
		assert.equal(r.ops, null);
		assert.match(r.error, /lone SEARCH/);
	});

	it("unclosed marker → parse error names the IDENT", () => {
		const body = "<<APPEND content but no closer";
		const r = parseMarkerBody(body);
		assert.equal(r.ops, null);
		assert.match(r.error, /unclosed.*APPEND/);
	});

	it("turn-5-style truncated closer → unclosed error", () => {
		// Real model emission: opener `<<REPLACE`, closer truncated to
		// just `:::` or to nothing. Surface unclosed clearly.
		const body = "<<REPLACE\ncontent\n";
		const r = parseMarkerBody(body);
		assert.equal(r.ops, null);
		assert.match(r.error, /unclosed.*REPLACE/);
	});
});

describe("parseMarkerBody — nesting via IDENT suffix", () => {
	it("inner markers with different IDENT survive as content of outer", () => {
		const body = [
			"<<SEARCH_OUTER",
			"<<SEARCH",
			"inner old",
			"SEARCH",
			"<<REPLACE",
			"inner new",
			"REPLACE",
			"SEARCH_OUTER",
			"<<REPLACE_OUTER",
			"replacement",
			"REPLACE_OUTER",
		].join("\n");
		const r = parseMarkerBody(body);
		assert.deepEqual(r.ops, [
			{
				op: "search_replace",
				search: [
					"<<SEARCH",
					"inner old",
					"SEARCH",
					"<<REPLACE",
					"inner new",
					"REPLACE",
				].join("\n"),
				replace: "replacement",
			},
		]);
	});
});
