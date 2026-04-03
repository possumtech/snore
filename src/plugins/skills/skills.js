import fs from "node:fs/promises";
import { join } from "node:path";

export default class SkillsPlugin {
	static register(hooks) {
		const r = hooks.rpc.registry;

		// --- Skills (stackable, per-run entries) ---

		r.register("skill/add", {
			handler: async (params, ctx) => {
				if (!params.name) throw new Error("name is required");
				if (!params.run) throw new Error("run is required");

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				const project = await ctx.db.get_project_by_id.get({
					id: runRow.project_id,
				});

				const body = await loadFile(project, "skills", params.name);
				const store = ctx.projectAgent.store;
				await store.upsert(
					runRow.id,
					runRow.next_turn,
					`skill://${params.name}`,
					body,
					"full",
					{
						attributes: {
							name: params.name,
							source: filePath(project, "skills", params.name),
						},
					},
				);

				return { status: "ok", skill: params.name };
			},
			description: "Add a skill to a run. Reads from config/skills/{name}.md.",
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

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				const store = ctx.projectAgent.store;
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

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				const store = ctx.projectAgent.store;
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
			handler: async (_params, ctx) => {
				const project = await ctx.db.get_project_by_id.get({
					id: ctx.projectId,
				});
				return listAvailable(project, "skills");
			},
			description: "List available skill files. Returns [{ name, path }].",
			requiresInit: true,
		});

		// --- Personas (exclusive, per-run column) ---

		r.register("persona/set", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`Run not found: ${params.run}`);

				let text = params.text;
				if (params.name && !text) {
					const project = await ctx.db.get_project_by_id.get({
						id: runRow.project_id,
					});
					text = await loadFile(project, "personas", params.name);
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
				"Set persona on a run. Pass name to load from config/personas/{name}.md, or text for raw content. Pass neither to clear.",
			params: {
				run: "string — run alias",
				name: "string? — persona filename (without .md)",
				text: "string? — raw persona text (overrides name)",
			},
			requiresInit: true,
		});

		r.register("listPersonas", {
			handler: async (_params, ctx) => {
				const project = await ctx.db.get_project_by_id.get({
					id: ctx.projectId,
				});
				return listAvailable(project, "personas");
			},
			description: "List available persona files. Returns [{ name, path }].",
			requiresInit: true,
		});
	}
}

// --- Shared file helpers ---

function configDir(project, subfolder) {
	if (project?.config_path) return join(project.config_path, subfolder);
	if (project?.project_root)
		return join(project.project_root, ".rummy", subfolder);
	return null;
}

function filePath(project, subfolder, name) {
	const dir = configDir(project, subfolder);
	if (!dir) return null;
	return join(dir, `${name}.md`);
}

async function loadFile(project, subfolder, name) {
	const path = filePath(project, subfolder, name);
	if (!path) throw new Error("No config path configured for this project");
	try {
		return await fs.readFile(path, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") {
			throw new Error(`Not found: ${path}`);
		}
		throw err;
	}
}

async function listAvailable(project, subfolder) {
	const dir = configDir(project, subfolder);
	if (!dir) return [];
	try {
		const files = await fs.readdir(dir);
		return files
			.filter((f) => f.endsWith(".md"))
			.map((f) => ({
				name: f.replace(".md", ""),
				path: join(dir, f),
			}));
	} catch {
		return [];
	}
}
