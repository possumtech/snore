import assert from "node:assert/strict";
import { describe, it } from "node:test";
import config from "../../agent/config.js";
import Think from "./think.js";

function makeCore() {
	const events = {
		schemes: [],
		toolEnsured: 0,
		filters: [],
	};
	return {
		events,
		registerScheme(opts) {
			events.schemes.push(opts);
		},
		ensureTool() {
			events.toolEnsured++;
		},
		filter(name, fn) {
			events.filters.push({ name, fn });
		},
	};
}

describe("Think plugin", () => {
	it("registers the think scheme as logging + invisible", () => {
		const core = makeCore();
		new Think(core);
		assert.equal(core.events.schemes.length, 1);
		assert.deepEqual(core.events.schemes[0], {
			modelVisible: 0,
			category: "logging",
		});
	});

	it("registers an llm.reasoning filter regardless of THINK config", () => {
		const core = makeCore();
		new Think(core);
		const reasoningFilter = core.events.filters.find(
			(f) => f.name === "llm.reasoning",
		);
		assert.ok(reasoningFilter, "llm.reasoning filter should register");
	});

	it("conditionally registers tooldoc filter based on config.THINK", () => {
		const core = makeCore();
		new Think(core);
		const docsFilter = core.events.filters.find(
			(f) => f.name === "instructions.toolDocs",
		);
		if (config.THINK) {
			assert.ok(docsFilter, "tooldoc filter should register when THINK truthy");
			assert.equal(core.events.toolEnsured, 1);
		} else {
			assert.equal(docsFilter, undefined);
			assert.equal(core.events.toolEnsured, 0);
		}
	});

	it("llm.reasoning filter merges <think> command bodies into reasoning seed", async () => {
		const core = makeCore();
		new Think(core);
		const reasoningFilter = core.events.filters.find(
			(f) => f.name === "llm.reasoning",
		).fn;

		const seed = "prior reasoning";
		const commands = [
			{ name: "think", body: "step A" },
			{ name: "set", body: "ignored" },
			{ name: "think", body: "step B" },
		];
		const result = await reasoningFilter(seed, { commands });
		assert.equal(result, "prior reasoning\nstep A\nstep B");
	});

	it("llm.reasoning filter handles empty seed", async () => {
		const core = makeCore();
		new Think(core);
		const reasoningFilter = core.events.filters.find(
			(f) => f.name === "llm.reasoning",
		).fn;

		const result = await reasoningFilter("", {
			commands: [{ name: "think", body: "only think" }],
		});
		assert.equal(result, "only think");
	});

	it("llm.reasoning filter returns seed unchanged when no <think> commands present", async () => {
		const core = makeCore();
		new Think(core);
		const reasoningFilter = core.events.filters.find(
			(f) => f.name === "llm.reasoning",
		).fn;

		const result = await reasoningFilter("just seed", {
			commands: [{ name: "set", body: "x" }],
		});
		assert.equal(result, "just seed");
	});

	it("llm.reasoning filter skips empty/missing think bodies", async () => {
		const core = makeCore();
		new Think(core);
		const reasoningFilter = core.events.filters.find(
			(f) => f.name === "llm.reasoning",
		).fn;

		const result = await reasoningFilter("seed", {
			commands: [
				{ name: "think", body: "" },
				{ name: "think", body: null },
				{ name: "think", body: "real one" },
			],
		});
		assert.equal(result, "seed\nreal one");
	});
});
