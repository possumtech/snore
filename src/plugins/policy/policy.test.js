import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Policy from "./policy.js";

// Capture the filters the plugin registers so we can call them directly.
// Policy registers two: ask-mode at priority 1, delivery-mode at priority 2.
function makeCore({ errorEmits = null } = {}) {
	const filters = [];
	return {
		filter(name, fn, priority) {
			if (name === "entry.recording") filters.push({ fn, priority });
		},
		hooks: {
			error: {
				log: {
					emit: async (payload) => {
						if (errorEmits) errorEmits.push(payload);
					},
				},
			},
		},
		getFilters: () => filters.toSorted((a, b) => a.priority - b.priority),
	};
}

function entry(scheme, attrs = {}, body = "", path = `${scheme}://x`) {
	return {
		path,
		scheme,
		attributes: attrs,
		body,
		state: "resolved",
	};
}

// Stand-in for the Entries store; only `getEntriesByPattern` is consulted by the
// delivery-mode shield, and only against `unknown://**`.
function makeStore({ visibleUnknowns = 0 } = {}) {
	return {
		getEntriesByPattern: async (_runId, pattern) => {
			if (pattern !== "unknown://**") return [];
			return Array.from({ length: visibleUnknowns }, (_, i) => ({
				path: `unknown://x${i}`,
				visibility: "visible",
			}));
		},
	};
}

function newFilter({ errorEmits = null } = {}) {
	const core = makeCore({ errorEmits });
	new Policy(core);
	const fs = core.getFilters();
	// Compose both filters in registration order (ask first, then delivery).
	return async (e, ctx) => {
		let out = e;
		for (const { fn } of fs) {
			out = await fn(out, ctx);
			if (out.state === "failed") return out;
		}
		return out;
	};
}

describe("Policy plugin: enforceAskMode filter", () => {
	it("registers an entry.recording filter", () => {
		const filter = newFilter();
		assert.equal(typeof filter, "function");
	});

	it("act mode: passes every entry through unchanged", async () => {
		const filter = newFilter();
		const sh = entry("sh");
		const out = await filter(sh, {
			mode: "act",
			store: makeStore(),
			runId: 1,
			turn: 1,
			loopId: 1,
		});
		assert.strictEqual(out, sh);
	});

	it("ask mode + <sh>: fails with permission outcome; rejection surfaces via error.log; original body preserved", async () => {
		const errorEmits = [];
		const filter = newFilter({ errorEmits });
		const sh = entry("sh");
		sh.body = "ls -la";
		const result = await filter(sh, {
			mode: "ask",
			store: makeStore(),
			runId: 1,
			turn: 1,
			loopId: 1,
		});
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.equal(result.body, "ls -la", "original body preserved");
		assert.equal(errorEmits.length, 1);
		assert.equal(errorEmits[0].message, "Rejected <sh> in ask mode");
		assert.equal(errorEmits[0].status, 403);
	});

	it("ask mode + <set> on bare-path file with body: fails; original body preserved; rejection in error.log", async () => {
		const errorEmits = [];
		const filter = newFilter({ errorEmits });
		const result = await filter(
			entry("set", { path: "src/x.js" }, "new content"),
			{ mode: "ask", store: makeStore(), runId: 1, turn: 1, loopId: 1 },
		);
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.equal(result.body, "new content", "original body preserved");
		assert.equal(errorEmits.length, 1);
		assert.match(errorEmits[0].message, /file edit to src\/x\.js/);
	});

	it("ask mode + <set> on bare-path file WITHOUT body: passes (visibility-only set)", async () => {
		const filter = newFilter();
		const e = entry("set", { path: "src/x.js" }, "");
		const result = await filter(e, {
			mode: "ask",
			store: makeStore(),
			runId: 1,
			turn: 1,
			loopId: 1,
		});
		assert.strictEqual(result, e);
	});

	it("ask mode + <set> on schemed path (known://): passes (entries are not files)", async () => {
		const filter = newFilter();
		const e = entry("set", { path: "known://x" }, "body");
		const result = await filter(e, {
			mode: "ask",
			store: makeStore(),
			runId: 1,
			turn: 1,
			loopId: 1,
		});
		assert.strictEqual(result, e);
	});

	it("ask mode + <rm> on bare-path file: fails; rejection in error.log", async () => {
		const errorEmits = [];
		const filter = newFilter({ errorEmits });
		const result = await filter(entry("rm", { path: "src/x.js" }), {
			mode: "ask",
			store: makeStore(),
			runId: 1,
			turn: 1,
			loopId: 1,
		});
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.equal(errorEmits.length, 1);
		assert.match(errorEmits[0].message, /file rm of src\/x\.js/);
	});

	it("ask mode + <rm> on schemed path: passes", async () => {
		const filter = newFilter();
		const e = entry("rm", { path: "known://x" });
		const result = await filter(e, {
			mode: "ask",
			store: makeStore(),
			runId: 1,
			turn: 1,
			loopId: 1,
		});
		assert.strictEqual(result, e);
	});

	it("ask mode + <rm> falls back to entry.path when attributes.path missing", async () => {
		const errorEmits = [];
		const filter = newFilter({ errorEmits });
		const result = await filter(
			{
				path: "src/x.js",
				scheme: "rm",
				attributes: {},
				body: "",
				state: "resolved",
			},
			{ mode: "ask", store: makeStore(), runId: 1, turn: 1, loopId: 1 },
		);
		assert.equal(result.state, "failed");
		assert.match(errorEmits[0].message, /file rm of src\/x\.js/);
	});

	it("ask mode + <mv> with file destination: fails; rejection in error.log", async () => {
		const errorEmits = [];
		const filter = newFilter({ errorEmits });
		const result = await filter(entry("mv", { from: "a", to: "src/dest.js" }), {
			mode: "ask",
			store: makeStore(),
			runId: 1,
			turn: 1,
			loopId: 1,
		});
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.match(errorEmits[0].message, /Rejected mv to file src\/dest\.js/);
	});

	it("ask mode + <cp> with file destination: fails; rejection in error.log", async () => {
		const errorEmits = [];
		const filter = newFilter({ errorEmits });
		const result = await filter(entry("cp", { from: "a", to: "out/dest.js" }), {
			mode: "ask",
			store: makeStore(),
			runId: 1,
			turn: 1,
			loopId: 1,
		});
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.match(errorEmits[0].message, /Rejected cp to file out\/dest\.js/);
	});

	it("ask mode + <mv> with schemed destination: passes", async () => {
		const filter = newFilter();
		const e = entry("mv", { from: "a", to: "known://x" });
		const result = await filter(e, {
			mode: "ask",
			store: makeStore(),
			runId: 1,
			turn: 1,
			loopId: 1,
		});
		assert.strictEqual(result, e);
	});

	it("ask mode + unrelated schemes (<get>, <env>): passes", async () => {
		const filter = newFilter();
		for (const scheme of ["get", "env", "update", "search"]) {
			const e = entry(scheme, { path: "x" });
			const result = await filter(e, {
				mode: "ask",
				store: makeStore(),
				runId: 1,
				turn: 1,
				loopId: 1,
			});
			assert.strictEqual(result, e, `expected ${scheme} entry to pass through`);
		}
	});
});

describe("Policy plugin: enforceDeliveryMode filter (delivery coherence shield) (@fvsm_state_machine)", () => {
	it("no visible unknowns: file modification passes", async () => {
		const filter = newFilter();
		const e = entry("set", { path: "src/x.js" }, "new content");
		const result = await filter(e, {
			mode: "act",
			store: makeStore({ visibleUnknowns: 0 }),
			runId: 1,
			turn: 5,
			loopId: 1,
		});
		assert.strictEqual(result, e);
	});

	for (const visibleUnknowns of [1, 3]) {
		it(`${visibleUnknowns} visible unknown(s): file edit fails with the delivery coherence message; original body preserved`, async () => {
			const errorEmits = [];
			const filter = newFilter({ errorEmits });
			const result = await filter(
				entry("set", { path: "OC_RIVERS.md" }, "report content"),
				{
					mode: "act",
					store: makeStore({ visibleUnknowns }),
					runId: 1,
					turn: 5,
					loopId: 1,
				},
			);
			assert.equal(result.state, "failed");
			assert.equal(result.outcome, "permission");
			assert.equal(
				result.body,
				"report content",
				"original body preserved so the model can reflect on what it tried",
			);
			assert.equal(errorEmits.length, 1, "exactly one error.log emission");
			assert.equal(
				errorEmits[0].message,
				"YOU MUST NOT deliver while unknowns remain visible. Demote them (RESOLVED or REJECTED) first.",
			);
			assert.equal(errorEmits[0].status, 403);
		});

		it(`${visibleUnknowns} visible unknown(s): file rm fails`, async () => {
			const errorEmits = [];
			const filter = newFilter({ errorEmits });
			const result = await filter(entry("rm", { path: "src/x.js" }), {
				mode: "act",
				store: makeStore({ visibleUnknowns }),
				runId: 1,
				turn: 5,
				loopId: 1,
			});
			assert.equal(result.state, "failed");
			assert.match(
				errorEmits[0].message,
				/YOU MUST NOT deliver while unknowns remain visible/,
			);
		});

		it(`${visibleUnknowns} visible unknown(s): known:// schema entry write passes (schema entries are not file mods)`, async () => {
			const filter = newFilter();
			const e = entry("set", { path: "known://x" }, "factual content");
			const result = await filter(e, {
				mode: "act",
				store: makeStore({ visibleUnknowns }),
				runId: 1,
				turn: 5,
				loopId: 1,
			});
			assert.strictEqual(result, e);
		});

		it(`${visibleUnknowns} visible unknown(s): visibility-only set on file path passes (no body)`, async () => {
			const filter = newFilter();
			const e = entry(
				"set",
				{ path: "OC_RIVERS.md", visibility: "archived" },
				"",
			);
			const result = await filter(e, {
				mode: "act",
				store: makeStore({ visibleUnknowns }),
				runId: 1,
				turn: 5,
				loopId: 1,
			});
			assert.strictEqual(result, e);
		});
	}
});
