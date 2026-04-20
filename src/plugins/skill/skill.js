import fs from "node:fs/promises";
import { join } from "node:path";

export default class Skill {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({
			name: "skill",
			category: "data",
		});
		core.hooks.tools.onView("skill", (entry) => entry.body, "promoted");
		core.hooks.tools.onView("skill", () => "", "demoted");

		const r = core.hooks.rpc.registry;

		r.register("skill/add", {
			handler: async (params, ctx) => {
				if (!params.name) throw new Error("name is required");
				if (!params.run) throw new Error("run is required");

				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				const body = await loadFile("skills", params.name);
				const store = ctx.projectAgent.entries;
				await store.set({
					runId: runRow.id,
					turn: 0,
					path: `skill://${params.name}`,
					body,
					state: "resolved",
					attributes: {
						name: params.name,
						source: filePath("skills", params.name),
					},
				});

				return { status: "ok", skill: params.name };
			},
			description:
				"Add a skill to a run. Reads from RUMMY_HOME/skills/{name}.md.",
			params: {
				run: "string — run alias",
				name: "string — skill name (filename without .md)",
			},
			requiresInit: true,
		});

		r.register("skill/remove", {
			handler: async (params, ctx) => {
				if (!params.name) throw new Error("name is required");
				if (!params.run) throw new Error("run is required");

				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				const store = ctx.projectAgent.entries;
				await store.rm({ runId: runRow.id, path: `skill://${params.name}` });

				return { status: "ok" };
			},
			description: "Remove a skill from a run.",
			params: {
				run: "string — run alias",
				name: "string — skill name",
			},
			requiresInit: true,
		});

		r.register("getSkills", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");

				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				const store = ctx.projectAgent.entries;
				const entries = await store.getEntriesByPattern(
					runRow.id,
					"skill://*",
					null,
				);
				return entries.map((e) => ({
					name: e.path.replace("skill://", ""),
					status: e.status,
				}));
			},
			description: "List skills active on a run. Returns [{ name, status }].",
			params: { run: "string — run alias" },
			requiresInit: true,
		});

		r.register("listSkills", {
			handler: async () => listAvailable("skills"),
			description: "List available skill files. Returns [{ name, path }].",
			requiresInit: true,
		});

		// Persona methods extracted to persona plugin.
	}
}

function configDir(subfolder) {
	const home = process.env.RUMMY_HOME;
	if (home) return join(home, subfolder);
	return null;
}

function filePath(subfolder, name) {
	const dir = configDir(subfolder);
	if (!dir) return null;
	return join(dir, `${name}.md`);
}

async function loadFile(subfolder, name) {
	const path = filePath(subfolder, name);
	if (!path) throw new Error("RUMMY_HOME not configured");
	try {
		return await fs.readFile(path, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") throw new Error(`Not found: ${path}`);
		throw err;
	}
}

async function listAvailable(subfolder) {
	const dir = configDir(subfolder);
	if (!dir) return [];
	const files = await fs.readdir(dir);
	return files
		.filter((f) => f.endsWith(".md"))
		.map((f) => ({ name: f.replace(".md", ""), path: join(dir, f) }));
}
