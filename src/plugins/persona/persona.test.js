import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Persona from "./persona.js";

function makeCore() {
	const views = new Map();
	const schemes = [];
	return {
		registerScheme: (opts) => schemes.push(opts),
		hooks: {
			tools: {
				onView: (scheme, fn, vis) => {
					if (!views.has(scheme)) views.set(scheme, new Map());
					views.get(scheme).set(vis, fn);
				},
			},
		},
		_view: (scheme, vis) => views.get(scheme)?.get(vis),
		_schemes: schemes,
	};
}

describe("Persona plugin", () => {
	it("registers persona scheme + visible/summarized views", () => {
		const core = makeCore();
		new Persona(core);
		assert.deepEqual(core._schemes, [{ name: "persona", category: "data" }]);
		assert.equal(core._view("persona", "visible")({ body: "hi" }), "hi");
		assert.equal(core._view("persona", "summarized")(), "");
	});
});
