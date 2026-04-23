/**
 * Tool display order and mode-based exclusion.
 *
 * Covers @tool_documentation — priority ordering of advertised tools
 * and the mode/flag-driven trimming applied before each loop.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import TestDb from "../helpers/TestDb.js";

describe("tool display (@tool_documentation, @plugins_display_order)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("tool_display");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("tools are sorted by priority, not alphabetically", () => {
		const names = tdb.hooks.tools.names;
		const getIdx = names.indexOf("get");
		const askUserIdx = names.indexOf("ask_user");
		assert.ok(getIdx < askUserIdx, "get before ask_user");
	});

	it("ask mode excludes <sh>", () => {
		const tools = tdb.hooks.tools.resolveForLoop("ask");
		assert.ok(!tools.has("sh"), "sh excluded in ask mode");
		assert.ok(tools.has("get"), "get available in ask mode");
	});

	it("noInteraction flag removes ask_user", () => {
		const tools = tdb.hooks.tools.resolveForLoop("ask", {
			noInteraction: true,
		});
		assert.ok(!tools.has("ask_user"), "ask_user excluded");
	});

	it("noWeb flag removes search", () => {
		const tools = tdb.hooks.tools.resolveForLoop("ask", { noWeb: true });
		assert.ok(!tools.has("search"), "search excluded");
	});
});
