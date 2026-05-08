/**
 * Hedberg utility surface.
 *
 * Covers @hedberg — the pattern library exposed to every plugin
 * through `core.hooks.hedberg`.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import TestDb from "../helpers/TestDb.js";

describe("hedberg API (@hedberg, @plugins_hedberg)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("hedberg_api");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("hedberg utilities are accessible via core.hooks.hedberg", () => {
		const h = tdb.hooks.hedberg;
		assert.ok(h, "hedberg object exists on hooks");
		for (const name of ["match", "search", "replace", "generatePatch"]) {
			assert.strictEqual(typeof h[name], "function", `${name} is callable`);
		}
	});
});
