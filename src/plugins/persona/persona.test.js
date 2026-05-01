import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Persona from "./persona.js";

function makeCore() {
	const methods = new Map();
	return {
		hooks: {
			rpc: {
				registry: {
					register: (name, def) => methods.set(name, def),
				},
			},
		},
		_method: (name) => methods.get(name),
	};
}

describe("Persona plugin", () => {
	let originalHome;
	let tmpHome;

	beforeEach(async () => {
		originalHome = process.env.RUMMY_HOME;
		tmpHome = await mkdtemp(join(tmpdir(), "persona-test-"));
		process.env.RUMMY_HOME = tmpHome;
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.RUMMY_HOME;
		else process.env.RUMMY_HOME = originalHome;
		await rm(tmpHome, { recursive: true, force: true });
	});

	it("registers persona/set and listPersonas RPC methods", () => {
		const core = makeCore();
		new Persona(core);
		assert.ok(core._method("persona/set"));
		assert.ok(core._method("listPersonas"));
		assert.equal(core._method("persona/set").requiresInit, true);
	});

	describe("persona/set", () => {
		it("throws when run param missing", async () => {
			const core = makeCore();
			new Persona(core);
			const def = core._method("persona/set");
			await assert.rejects(def.handler({}, {}), /run is required/);
		});

		it("throws when run alias is unknown", async () => {
			const core = makeCore();
			new Persona(core);
			const def = core._method("persona/set");
			const ctx = {
				db: { get_run_by_alias: { get: async () => null } },
			};
			await assert.rejects(
				def.handler({ run: "missing" }, ctx),
				/Run not found/,
			);
		});

		it("clears persona when text and name both empty/absent", async () => {
			const core = makeCore();
			new Persona(core);
			const def = core._method("persona/set");
			let updated;
			const ctx = {
				db: {
					get_run_by_alias: { get: async () => ({ id: "r1" }) },
					update_run_config: {
						run: async (params) => {
							updated = params;
						},
					},
				},
			};
			const result = await def.handler({ run: "alias" }, ctx);
			assert.deepEqual(result, { status: "ok" });
			assert.equal(updated.persona, null);
		});

		it("sets persona to inline text when text param provided", async () => {
			const core = makeCore();
			new Persona(core);
			const def = core._method("persona/set");
			let updated;
			const ctx = {
				db: {
					get_run_by_alias: { get: async () => ({ id: "r1" }) },
					update_run_config: {
						run: async (params) => {
							updated = params;
						},
					},
				},
			};
			await def.handler({ run: "alias", text: "I am a senior engineer." }, ctx);
			assert.equal(updated.persona, "I am a senior engineer.");
		});

		it("loads persona from RUMMY_HOME/personas/{name}.md when name provided", async () => {
			const personaDir = join(tmpHome, "personas");
			await import("node:fs/promises").then(({ mkdir }) =>
				mkdir(personaDir, { recursive: true }),
			);
			await writeFile(join(personaDir, "scientist.md"), "I am a scientist.\n");

			const core = makeCore();
			new Persona(core);
			const def = core._method("persona/set");
			let updated;
			const ctx = {
				db: {
					get_run_by_alias: { get: async () => ({ id: "r1" }) },
					update_run_config: {
						run: async (params) => {
							updated = params;
						},
					},
				},
			};
			await def.handler({ run: "alias", name: "scientist" }, ctx);
			assert.match(updated.persona, /scientist/);
		});

		it("text overrides name when both provided", async () => {
			const core = makeCore();
			new Persona(core);
			const def = core._method("persona/set");
			let updated;
			const ctx = {
				db: {
					get_run_by_alias: { get: async () => ({ id: "r1" }) },
					update_run_config: {
						run: async (params) => {
							updated = params;
						},
					},
				},
			};
			await def.handler(
				{ run: "alias", text: "explicit", name: "scientist" },
				ctx,
			);
			assert.equal(updated.persona, "explicit");
		});
	});

	describe("listPersonas", () => {
		it("returns [] when RUMMY_HOME not set", async () => {
			delete process.env.RUMMY_HOME;
			const core = makeCore();
			new Persona(core);
			const def = core._method("listPersonas");
			const result = await def.handler({}, {});
			assert.deepEqual(result, []);
		});

		it("returns [{ name, path }] for each .md in personas dir", async () => {
			const personaDir = join(tmpHome, "personas");
			await import("node:fs/promises").then(({ mkdir }) =>
				mkdir(personaDir, { recursive: true }),
			);
			await writeFile(join(personaDir, "a.md"), "a");
			await writeFile(join(personaDir, "b.md"), "b");
			await writeFile(join(personaDir, "ignored.txt"), "x");

			const core = makeCore();
			new Persona(core);
			const def = core._method("listPersonas");
			const result = await def.handler({}, {});
			const names = result.map((r) => r.name).toSorted();
			assert.deepEqual(names, ["a", "b"]);
			for (const r of result) {
				assert.ok(r.path.endsWith(".md"));
			}
		});
	});
});
