import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import createHooks from "../../hooks/Hooks.js";
import PluginContext from "../../hooks/PluginContext.js";
import Cli from "./cli.js";

function makeCore() {
	const hooks = createHooks();
	const core = new PluginContext("cli", hooks);
	new Cli(core);
	return { hooks };
}

describe("Cli plugin", () => {
	let originalPrompt;

	beforeEach(() => {
		originalPrompt = process.env.RUMMY_PROMPT;
	});

	afterEach(() => {
		if (originalPrompt === undefined) delete process.env.RUMMY_PROMPT;
		else process.env.RUMMY_PROMPT = originalPrompt;
	});

	it("registers a boot.completed handler", () => {
		const { hooks } = makeCore();
		assert.ok(hooks.boot.completed);
		assert.equal(typeof hooks.boot.completed.emit, "function");
	});

	it("inert when RUMMY_PROMPT is not set: boot completes without side effects", async () => {
		delete process.env.RUMMY_PROMPT;
		const { hooks } = makeCore();
		// If this throws or exits, the test runner aborts. A clean return
		// proves the early-exit path runs.
		await hooks.boot.completed.emit({ db: {}, hooks });
	});
});
