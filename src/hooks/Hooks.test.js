import assert from "node:assert/strict";
import { describe, it } from "node:test";
import createHooks from "./Hooks.js";

describe("createHooks", () => {
	it("returns the documented top-level hook surface", () => {
		const h = createHooks();
		// Spot-check the major domains; full schema is the file itself.
		for (const key of [
			"boot",
			"project",
			"run",
			"loop",
			"turn",
			"proposal",
			"assembly",
			"instructions",
			"ask",
			"act",
			"llm",
			"prompt",
			"entry",
			"tool",
			"context",
			"error",
			"stream",
			"ui",
			"socket",
			"rpc",
			"tools",
		]) {
			assert.ok(key in h, `expected hooks to expose "${key}"`);
		}
	});

	it("event hooks expose on/off/emit", async () => {
		const h = createHooks();
		let calls = 0;
		const cb = async () => {
			calls += 1;
		};
		h.boot.completed.on(cb);
		await h.boot.completed.emit();
		assert.equal(calls, 1);
		h.boot.completed.off(cb);
		await h.boot.completed.emit();
		assert.equal(calls, 1);
	});

	it("filter hooks expose addFilter/filter and chain values", async () => {
		const h = createHooks();
		h.assembly.user.addFilter(async (v) => `${v}-1`);
		h.assembly.user.addFilter(async (v) => `${v}-2`);
		const out = await h.assembly.user.filter("seed");
		assert.equal(out, "seed-1-2");
	});

	it("llm.providers is an array (extension-by-push)", () => {
		const h = createHooks();
		assert.ok(Array.isArray(h.llm.providers));
		h.llm.providers.push({ name: "test", matches: () => true });
		assert.equal(h.llm.providers[0].name, "test");
	});

	it("rpc.registry is an instance with register/discover", () => {
		const h = createHooks();
		assert.equal(typeof h.rpc.registry.register, "function");
		assert.equal(typeof h.rpc.registry.discover, "function");
	});

	it("addFilter/applyFilters/addEvent/emitEvent shortcuts route into the registry", async () => {
		const h = createHooks();
		let captured;
		h.addFilter("custom.tag", async (v) => {
			captured = v;
			return `${v}!`;
		});
		const out = await h.applyFilters("custom.tag", "x");
		assert.equal(captured, "x");
		assert.equal(out, "x!");

		let evt = 0;
		h.addEvent("custom.evt", async () => {
			evt += 1;
		});
		await h.emitEvent("custom.evt");
		assert.equal(evt, 1);
	});
});
