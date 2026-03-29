import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import createHooks from "./Hooks.js";

describe("Hooks (createHooks)", () => {
	it("should provide a structured API for events and filters", async () => {
		const hooks = createHooks();
		let projectInitStarted = false;

		hooks.project.init.started.on(() => {
			projectInitStarted = true;
		});

		await hooks.project.init.started.emit();
		strictEqual(projectInitStarted, true);
	});

	it("should provide a structured API for filters", async () => {
		const hooks = createHooks();

		hooks.llm.response.addFilter((res) => {
			return `${res} [filtered]`;
		});

		const result = await hooks.llm.response.filter("Hello");
		strictEqual(result, "Hello [filtered]");
	});

	it("should allow registering turn processors", async () => {
		const hooks = createHooks();
		let turnProcessed = false;

		hooks.onTurn(async () => {
			turnProcessed = true;
		});

		await hooks.processTurn({});
		strictEqual(turnProcessed, true);
	});
});
