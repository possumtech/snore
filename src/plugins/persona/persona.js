import fs from "node:fs/promises";
import { join } from "node:path";

export default class Persona {
	#core;

	constructor(core) {
		this.#core = core;
		const r = core.hooks.rpc.registry;

		r.register("persona/set", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");

				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				let text = params.text;
				if (params.name && !text) {
					text = await loadFile(params.name);
				}

				// "Pass neither to clear" — empty string counts as clear too.
				let persona = null;
				if (text) persona = text;
				await ctx.db.update_run_config.run({
					id: runRow.id,
					temperature: null,
					persona,
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
			handler: async () => {
				const dir = configDir();
				if (!dir) return [];
				const files = await fs.readdir(dir);
				return files
					.filter((f) => f.endsWith(".md"))
					.map((f) => ({ name: f.replace(".md", ""), path: join(dir, f) }));
			},
			description: "List available persona files. Returns [{ name, path }].",
			requiresInit: true,
		});
	}
}

function configDir() {
	const home = process.env.RUMMY_HOME;
	if (home) return join(home, "personas");
	return null;
}

async function loadFile(name) {
	const dir = configDir();
	if (!dir) throw new Error("RUMMY_HOME not configured");
	const path = join(dir, `${name}.md`);
	try {
		return await fs.readFile(path, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") throw new Error(`Not found: ${path}`);
		throw err;
	}
}
