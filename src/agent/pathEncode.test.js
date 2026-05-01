import assert from "node:assert/strict";
import { describe, it } from "node:test";
import encodeSegment from "./pathEncode.js";

describe("encodeSegment", () => {
	it("converts spaces to underscores", () => {
		assert.equal(encodeSegment("hello world"), "hello_world");
	});

	it("URL-encodes after underscore substitution", () => {
		assert.equal(encodeSegment("foo bar/baz"), "foo_bar%2Fbaz");
	});

	it("encodes unsafe characters (colon, slash, question)", () => {
		assert.equal(encodeSegment("a:b"), "a%3Ab");
		assert.equal(encodeSegment("a/b"), "a%2Fb");
		assert.equal(encodeSegment("a?b"), "a%3Fb");
	});

	it("preserves alphanumerics and a few unreserved chars", () => {
		assert.equal(encodeSegment("abc123-_.~"), "abc123-_.~");
	});

	it("coerces non-strings via String()", () => {
		assert.equal(encodeSegment(42), "42");
		assert.equal(encodeSegment(true), "true");
	});

	it("handles empty input", () => {
		assert.equal(encodeSegment(""), "");
	});

	it("multiple spaces all become underscores", () => {
		assert.equal(encodeSegment("a  b   c"), "a__b___c");
	});
});
