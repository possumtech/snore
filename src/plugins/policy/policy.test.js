import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Policy from "./policy.js";

// Capture the filter the plugin registers so we can call it directly.
function makeCore() {
	let captured = null;
	return {
		filter(name, fn, _priority) {
			if (name === "entry.recording") captured = fn;
		},
		getFilter: () => captured,
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

function newFilter() {
	const core = makeCore();
	new Policy(core);
	return core.getFilter();
}

describe("Policy plugin: enforceAskMode filter", () => {
	it("registers an entry.recording filter", () => {
		const filter = newFilter();
		assert.equal(typeof filter, "function");
	});

	it("act mode: passes every entry through unchanged", async () => {
		const filter = newFilter();
		const sh = entry("sh");
		const out = await filter(sh, { mode: "act" });
		assert.strictEqual(out, sh);
	});

	it("ask mode + <sh>: fails with permission outcome", async () => {
		const filter = newFilter();
		const result = await filter(entry("sh"), { mode: "ask" });
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.equal(result.body, "Rejected <sh> in ask mode");
	});

	it("ask mode + <set> on bare-path file with body: fails", async () => {
		const filter = newFilter();
		const result = await filter(
			entry("set", { path: "src/x.js" }, "new content"),
			{ mode: "ask" },
		);
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.match(result.body, /file edit to src\/x\.js/);
	});

	it("ask mode + <set> on bare-path file WITHOUT body: passes (visibility-only set)", async () => {
		const filter = newFilter();
		const e = entry("set", { path: "src/x.js" }, "");
		const result = await filter(e, { mode: "ask" });
		assert.strictEqual(result, e);
	});

	it("ask mode + <set> on schemed path (known://): passes (entries are not files)", async () => {
		const filter = newFilter();
		const e = entry("set", { path: "known://x" }, "body");
		const result = await filter(e, { mode: "ask" });
		assert.strictEqual(result, e);
	});

	it("ask mode + <rm> on bare-path file: fails", async () => {
		const filter = newFilter();
		const result = await filter(entry("rm", { path: "src/x.js" }), {
			mode: "ask",
		});
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.match(result.body, /file rm of src\/x\.js/);
	});

	it("ask mode + <rm> on schemed path: passes", async () => {
		const filter = newFilter();
		const e = entry("rm", { path: "known://x" });
		const result = await filter(e, { mode: "ask" });
		assert.strictEqual(result, e);
	});

	it("ask mode + <rm> falls back to entry.path when attributes.path missing", async () => {
		const filter = newFilter();
		// No attrs.path — handler reads entry.path. Using a bare-path
		// (no scheme) entry to exercise the file branch.
		const result = await filter(
			{
				path: "src/x.js",
				scheme: "rm",
				attributes: {},
				body: "",
				state: "resolved",
			},
			{ mode: "ask" },
		);
		assert.equal(result.state, "failed");
		assert.match(result.body, /file rm of src\/x\.js/);
	});

	it("ask mode + <mv> with file destination: fails", async () => {
		const filter = newFilter();
		const result = await filter(entry("mv", { from: "a", to: "src/dest.js" }), {
			mode: "ask",
		});
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.match(result.body, /Rejected mv to file src\/dest\.js/);
	});

	it("ask mode + <cp> with file destination: fails", async () => {
		const filter = newFilter();
		const result = await filter(entry("cp", { from: "a", to: "out/dest.js" }), {
			mode: "ask",
		});
		assert.equal(result.state, "failed");
		assert.equal(result.outcome, "permission");
		assert.match(result.body, /Rejected cp to file out\/dest\.js/);
	});

	it("ask mode + <mv> with schemed destination: passes", async () => {
		const filter = newFilter();
		const e = entry("mv", { from: "a", to: "known://x" });
		const result = await filter(e, { mode: "ask" });
		assert.strictEqual(result, e);
	});

	it("ask mode + unrelated schemes (<get>, <env>): passes", async () => {
		const filter = newFilter();
		for (const scheme of ["get", "env", "update", "search"]) {
			const e = entry(scheme, { path: "x" });
			const result = await filter(e, { mode: "ask" });
			assert.strictEqual(result, e, `expected ${scheme} entry to pass through`);
		}
	});
});
