import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Hedberg from "./hedberg.js";

describe("Hedberg plugin", () => {
	it("constructor exposes hedberg utilities on core.hooks.hedberg", () => {
		const hooks = createHooks();
		const core = new PluginContext("hedberg", hooks);
		new Hedberg(core);
		assert.equal(typeof hooks.hedberg.match, "function");
		assert.equal(typeof hooks.hedberg.search, "function");
		assert.equal(typeof hooks.hedberg.replace, "function");
		assert.equal(typeof hooks.hedberg.parseSed, "function");
		assert.equal(typeof hooks.hedberg.parseEdits, "function");
		assert.equal(typeof hooks.hedberg.generatePatch, "function");
	});

	describe("Hedberg.replace", () => {
		it("literal substring replacement returns patch with all matches replaced", () => {
			const result = Hedberg.replace("foo bar foo", "foo", "baz");
			assert.equal(result.patch, "baz bar baz");
			assert.equal(result.error, null);
		});

		it("returns no patch (via heuristic) when literal search not found and heuristic also fails", () => {
			const result = Hedberg.replace("nothing matches", "absent", "x");
			assert.ok(!result.patch);
		});

		it("sed=true with a global regex overrides literal", () => {
			const result = Hedberg.replace("a1 b2 c3", "\\d", "X", {
				sed: true,
				flags: "g",
			});
			assert.equal(result.patch, "aX bX cX");
		});

		it("sed=true unescapes regex-meta backslashes in replacement", () => {
			const result = Hedberg.replace("abc", "a", "\\.A", {
				sed: true,
				flags: "g",
			});
			assert.equal(result.patch, ".Abc");
		});

		it("sed=true with invalid regex falls through to literal substitution", () => {
			const result = Hedberg.replace("abc", "a", "X", {
				sed: true,
				flags: "[bad",
			});
			assert.equal(result.patch, "Xbc");
		});

		it("sed=true that produces no change → patch=null, then literal kicks in", () => {
			// sed regex that matches but body.replace yields the same string
			const result = Hedberg.replace("abc", "abc", "abc", {
				sed: true,
				flags: "g",
			});
			// regex-replace yields same body → patch reset to null → literal includes("abc") → replaceAll → still abc → patch="abc"
			assert.equal(result.patch, "abc");
		});

		it("preserves searchText / replaceText in the result", () => {
			const result = Hedberg.replace("hello", "hello", "world");
			assert.equal(result.searchText, "hello");
			assert.equal(result.replaceText, "world");
		});
	});
});
