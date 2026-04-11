import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Rm from "./rm.js";

describe("Rm", () => {
	const plugin = new Rm({
		registerScheme() {},
		on() {},
		filter() {},
	});

	it("full renders rm path", () => {
		const result = plugin.full({
			attributes: { path: "known://old" },
			body: "",
		});
		assert.ok(result.includes("known://old"));
	});

	it("full lists removed paths when body is present", () => {
		const result = plugin.full({
			attributes: { path: "known://chunk_*" },
			body: "known://chunk_1\nknown://chunk_2\nknown://chunk_3",
		});
		assert.ok(result.includes("# rm known://chunk_*"));
		assert.ok(result.includes("known://chunk_1"));
		assert.ok(result.includes("known://chunk_2"));
		assert.ok(result.includes("known://chunk_3"));
	});

	it("summary renders rm path", () => {
		const result = plugin.summary({
			attributes: { path: "known://old" },
			body: "",
		});
		assert.ok(result.includes("known://old"));
	});
});
