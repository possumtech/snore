import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Skill from "./skill.js";

function makeCore() {
	const methods = new Map();
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
			rpc: {
				registry: {
					register: (name, def) => methods.set(name, def),
				},
			},
		},
		_method: (name) => methods.get(name),
		_view: (scheme, vis) => views.get(scheme)?.get(vis),
		_schemes: schemes,
	};
}

describe("Skill plugin", () => {
	let originalHome;
	let tmpHome;

	beforeEach(async () => {
		originalHome = process.env.RUMMY_HOME;
		tmpHome = await mkdtemp(join(tmpdir(), "skill-test-"));
		process.env.RUMMY_HOME = tmpHome;
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.RUMMY_HOME;
		else process.env.RUMMY_HOME = originalHome;
		await rm(tmpHome, { recursive: true, force: true });
	});

	it("registers skill scheme + visible/summarized views", () => {
		const core = makeCore();
		new Skill(core);
		assert.deepEqual(core._schemes, [{ name: "skill", category: "data" }]);
		assert.equal(core._view("skill", "visible")({ body: "hi" }), "hi");
		assert.equal(core._view("skill", "summarized")(), "");
	});

	it("registers all four RPC methods (skill/add, skill/remove, getSkills, listSkills)", () => {
		const core = makeCore();
		new Skill(core);
		for (const m of ["skill/add", "skill/remove", "getSkills", "listSkills"]) {
			assert.ok(core._method(m), `expected ${m} to be registered`);
			assert.equal(core._method(m).requiresInit, true);
		}
	});

	describe("skill/add", () => {
		it("throws when name missing", async () => {
			const core = makeCore();
			new Skill(core);
			const def = core._method("skill/add");
			await assert.rejects(def.handler({ run: "r" }, {}), /name is required/);
		});

		it("throws when run missing", async () => {
			const core = makeCore();
			new Skill(core);
			const def = core._method("skill/add");
			await assert.rejects(def.handler({ name: "n" }, {}), /run is required/);
		});

		it("throws when run alias is unknown", async () => {
			const core = makeCore();
			new Skill(core);
			const def = core._method("skill/add");
			await assert.rejects(
				def.handler(
					{ run: "missing", name: "n" },
					{ db: { get_run_by_alias: { get: async () => null } } },
				),
				/Run not found/,
			);
		});

		it("loads skill body from RUMMY_HOME/skills and stores at skill://{name}", async () => {
			const skillDir = join(tmpHome, "skills");
			await mkdir(skillDir, { recursive: true });
			await writeFile(join(skillDir, "foo.md"), "skill body");

			const core = makeCore();
			new Skill(core);
			const def = core._method("skill/add");
			let stored;
			const ctx = {
				db: {
					get_run_by_alias: { get: async () => ({ id: "r1" }) },
				},
				projectAgent: {
					entries: {
						set: async (params) => {
							stored = params;
						},
					},
				},
			};
			const result = await def.handler({ run: "alias", name: "foo" }, ctx);
			assert.deepEqual(result, { status: "ok", skill: "foo" });
			assert.equal(stored.path, "skill://foo");
			assert.equal(stored.body, "skill body");
			assert.equal(stored.attributes.name, "foo");
			assert.match(stored.attributes.source, /skills\/foo\.md$/);
		});

		it("throws when RUMMY_HOME not configured", async () => {
			delete process.env.RUMMY_HOME;
			const core = makeCore();
			new Skill(core);
			const def = core._method("skill/add");
			const ctx = {
				db: {
					get_run_by_alias: { get: async () => ({ id: "r1" }) },
				},
				projectAgent: { entries: { set: async () => {} } },
			};
			await assert.rejects(
				def.handler({ run: "a", name: "n" }, ctx),
				/RUMMY_HOME not configured/,
			);
		});
	});

	describe("skill/remove", () => {
		it("throws when name missing", async () => {
			const core = makeCore();
			new Skill(core);
			const def = core._method("skill/remove");
			await assert.rejects(def.handler({ run: "r" }, {}), /name is required/);
		});

		it("calls store.rm at skill://{name}", async () => {
			const core = makeCore();
			new Skill(core);
			const def = core._method("skill/remove");
			let removed;
			const ctx = {
				db: {
					get_run_by_alias: { get: async () => ({ id: "r1" }) },
				},
				projectAgent: {
					entries: {
						rm: async (p) => {
							removed = p;
						},
					},
				},
			};
			const result = await def.handler({ run: "alias", name: "foo" }, ctx);
			assert.deepEqual(result, { status: "ok" });
			assert.equal(removed.path, "skill://foo");
		});
	});

	describe("getSkills", () => {
		it("throws when run missing", async () => {
			const core = makeCore();
			new Skill(core);
			const def = core._method("getSkills");
			await assert.rejects(def.handler({}, {}), /run is required/);
		});

		it("lists skill entries with name + status", async () => {
			const core = makeCore();
			new Skill(core);
			const def = core._method("getSkills");
			const ctx = {
				db: { get_run_by_alias: { get: async () => ({ id: "r1" }) } },
				projectAgent: {
					entries: {
						getEntriesByPattern: async () => [
							{ path: "skill://foo", status: "resolved" },
							{ path: "skill://bar", status: "resolved" },
						],
					},
				},
			};
			const result = await def.handler({ run: "alias" }, ctx);
			assert.deepEqual(result, [
				{ name: "foo", status: "resolved" },
				{ name: "bar", status: "resolved" },
			]);
		});
	});

	describe("listSkills", () => {
		it("returns [] when RUMMY_HOME not set", async () => {
			delete process.env.RUMMY_HOME;
			const core = makeCore();
			new Skill(core);
			const def = core._method("listSkills");
			const result = await def.handler({}, {});
			assert.deepEqual(result, []);
		});

		it("returns [{ name, path }] for each .md in skills dir", async () => {
			const skillDir = join(tmpHome, "skills");
			await mkdir(skillDir, { recursive: true });
			await writeFile(join(skillDir, "a.md"), "a");
			await writeFile(join(skillDir, "b.md"), "b");
			await writeFile(join(skillDir, "ignored.txt"), "x");

			const core = makeCore();
			new Skill(core);
			const def = core._method("listSkills");
			const result = await def.handler({}, {});
			assert.deepEqual(result.map((r) => r.name).toSorted(), ["a", "b"]);
		});
	});
});
