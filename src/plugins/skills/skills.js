import fs from "node:fs/promises";
import { join } from "node:path";

export default class Skills {
	#core;

	constructor(core) {
		this.#core = core;
		const r = core.hooks.rpc.registry;

		r.register("skill/add", {
			handler: async (params, ctx) => {
				if (!params.name) throw new Error("name is required");
				if (!params.run) throw new Error("run is required");

				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				const body = await loadFile("skills", params.name);
				const store = ctx.projectAgent.entries;
				await store.upsert(
					runRow.id,
					runRow.next_turn,
					`skill://${params.name}`,
					body,
					"full",
					{
						attributes: {
							name: params.name,
							source: filePath("skills", params.name),
						},
					},
				);

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
				await store.remove(runRow.id, `skill://${params.name}`);

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
					state: e.state,
				}));
			},
			description: "List skills active on a run. Returns [{ name, state }].",
			params: { run: "string — run alias" },
			requiresInit: true,
		});

		r.register("listSkills", {
			handler: async () => listAvailable("skills"),
			description: "List available skill files. Returns [{ name, path }].",
			requiresInit: true,
		});

		r.register("persona/set", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");

				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				let text = params.text;
				if (params.name && !text) {
					text = await loadFile("personas", params.name);
				}

				await ctx.db.update_run_config.run({
					id: runRow.id,
					temperature: null,
					persona: text || null,
					context_limit: null,
					model: null,
				});

				return { status: "ok" };
			},
			description:
				"Set persona on a run. Pass name or text. Pass neither to clear.",
			params: {
				run: "string — run alias",
				name: "string? — persona filename (without .md)",
				text: "string? — raw persona text (overrides name)",
			},
			requiresInit: true,
		});

		r.register("listPersonas", {
			handler: async () => listAvailable("personas"),
			description: "List available persona files. Returns [{ name, path }].",
			requiresInit: true,
		});
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
	try {
		const files = await fs.readdir(dir);
		return files
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({ name: f.replace(".md", ""), path: join(dir, f) }));
	} catch {
		return [];
	}
}
