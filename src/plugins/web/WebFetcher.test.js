import assert from "node:assert";
import { describe, it } from "node:test";
import WebFetcher from "./WebFetcher.js";

describe("WebFetcher", () => {
	describe("cleanUrl", () => {
		it("strips query params", () => {
			assert.strictEqual(
				WebFetcher.cleanUrl("https://example.com/page?foo=bar"),
				"https://example.com/page",
			);
		});

		it("strips hash", () => {
			assert.strictEqual(
				WebFetcher.cleanUrl("https://example.com/page#section"),
				"https://example.com/page",
			);
		});

		it("strips trailing slash", () => {
			assert.strictEqual(
				WebFetcher.cleanUrl("https://example.com/page/"),
				"https://example.com/page",
			);
		});

		it("preserves path", () => {
			assert.strictEqual(
				WebFetcher.cleanUrl("https://docs.example.com/api/v2"),
				"https://docs.example.com/api/v2",
			);
		});
	});
});
