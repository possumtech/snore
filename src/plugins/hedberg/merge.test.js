import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyMerge, buildMerge } from "./merge.js";

describe("buildMerge", () => {
	it("empty searchText → whole-body replace block", () => {
		const m = buildMerge("", "new body");
		assert.equal(m, "<<<<<<< SEARCH\n=======\nnew body\n>>>>>>> REPLACE");
	});

	it("non-empty searchText → partial-replace block", () => {
		const m = buildMerge("old", "new");
		assert.equal(m, "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE");
	});

	it("nullish searchText is treated as empty (whole-body)", () => {
		const m = buildMerge(null, "x");
		assert.equal(m, "<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE");
	});
});

describe("applyMerge", () => {
	it("whole-body replace block overwrites the body", () => {
		const merge = buildMerge("", "fresh");
		assert.equal(applyMerge("anything", merge), "fresh");
	});

	it("partial-replace substitutes the first match verbatim", () => {
		const merge = buildMerge("foo", "bar");
		assert.equal(applyMerge("the foo here", merge), "the bar here");
	});

	it("non-matching SEARCH leaves body unchanged", () => {
		const merge = buildMerge("absent", "x");
		assert.equal(applyMerge("some body", merge), "some body");
	});

	it("multiple blocks apply in order", () => {
		const merge = `${buildMerge("foo", "FOO")}${buildMerge("baz", "BAZ")}`;
		assert.equal(applyMerge("foo bar baz", merge), "FOO bar BAZ");
	});

	it("whole-body block following partial-replace wins (last writer)", () => {
		const merge = `${buildMerge("foo", "FOO")}${buildMerge("", "complete")}`;
		assert.equal(applyMerge("foo bar", merge), "complete");
	});

	it("multiline SEARCH/REPLACE handles newlines verbatim", () => {
		const merge = buildMerge("line1\nline2", "single");
		assert.equal(
			applyMerge("pre\nline1\nline2\npost", merge),
			"pre\nsingle\npost",
		);
	});

	it("malformed block (no =======) is skipped silently", () => {
		const merge = "<<<<<<< SEARCH\nfoo\n>>>>>>> REPLACE";
		assert.equal(applyMerge("the foo here", merge), "the foo here");
	});

	it("round-trip: applyMerge(buildMerge) for whole-body replaces preserves replaceText", () => {
		const replaceText = "any text\nwith newlines";
		assert.equal(
			applyMerge("ignored", buildMerge("", replaceText)),
			replaceText,
		);
	});
});
