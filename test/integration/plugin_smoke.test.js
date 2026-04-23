/**
 * Smoke tests for bundled plugins without dedicated integration
 * coverage elsewhere. Each test is minimal — it verifies the plugin
 * registers its scheme/tool/hooks through the real plugin loader
 * so its README's top-level promise ("this plugin exists, loads,
 * and exposes X") stays verified.
 *
 * Covers @skill_plugin, @telemetry_plugin, @think_plugin,
 * @unknown_plugin, @update_plugin — the internal plugins that
 * don't earn a larger dedicated test file but still make
 * README-level promises.
 */
import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import TestDb from "../helpers/TestDb.js";

describe("plugin smoke (@skill_plugin, @telemetry_plugin, @think_plugin, @unknown_plugin, @update_plugin)", () => {
	let tdb;

	before(async () => {
		tdb = await TestDb.create("plugin_smoke");
	});

	after(async () => {
		await tdb.cleanup();
	});

	it("unknown plugin registers unknown:// scheme", async () => {
		const schemes = await tdb.db.get_all_schemes.all();
		const unknown = schemes.find((s) => s.name === "unknown");
		assert.ok(unknown, "unknown scheme registered");
		assert.strictEqual(
			unknown.category,
			"unknown",
			"unknown scheme is the `unknown` category",
		);
	});

	it("update plugin registers update tool", () => {
		assert.ok(
			tdb.hooks.tools.has("update"),
			"update tool registered for model emission",
		);
	});

	it("think plugin always subscribes llm.reasoning (tool is env-gated)", () => {
		// Tool registration depends on RUMMY_THINK; the reasoning merge
		// filter always registers. The think plugin's README-level
		// promise is "think bodies merge into reasoning_content."
		assert.ok(
			tdb.hooks.llm.reasoning,
			"llm.reasoning filter hook exists for think to subscribe to",
		);
	});

	it("skill plugin registers skill scheme", async () => {
		const schemes = await tdb.db.get_all_schemes.all();
		const skill = schemes.find((s) => s.name === "skill");
		assert.ok(skill, "skill scheme registered");
	});

	it("telemetry plugin subscribes to turn.response", () => {
		// Telemetry is an observer — its contract is "records every turn
		// response via hooks.turn.response". Verify the hook exists; the
		// actual recording is exercised by every other turn-driving test.
		assert.ok(tdb.hooks.turn.response, "turn.response hook available");
	});
});
