import { isAbsolute, relative } from "node:path";

export default class File {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("full", this.full.bind(this));

		// Register identity projections for schemes that just pass through body
		for (const scheme of ["known", "skill", "ask", "act", "progress"]) {
			core.hooks.tools.onProject(scheme, (entry) => entry.body);
		}
	}

	full(entry) {
		return entry.body;
	}

	static async activate(
		db,
		knownStore,
		projectId,
		pattern,
		visibility = "active",
	) {
		const path = await normalizePath(db, projectId, pattern);
		if (!path) return { status: "ok" };

		await db.upsert_file_constraint.run({
			project_id: projectId,
			pattern: path,
			visibility,
		});

		if (visibility === "ignore") {
			const runs = await db.get_all_runs.all({ project_id: projectId });
			for (const run of runs) {
				await knownStore.demoteByPattern(run.id, path, null);
			}
		}

		return { status: "ok" };
	}

	static async ignore(db, knownStore, projectId, pattern) {
		return File.activate(db, knownStore, projectId, pattern, "ignore");
	}

	static async drop(db, projectId, pattern) {
		const path = await normalizePath(db, projectId, pattern);
		if (!path) return { status: "ok" };

		await db.delete_file_constraint.run({
			project_id: projectId,
			pattern: path,
		});

		return { status: "ok" };
	}
}

async function normalizePath(db, projectId, path) {
	if (!isAbsolute(path)) return path;
	const project = await db.get_project_by_id.get({ id: projectId });
	if (!project) return path;
	return relative(project.project_root, path);
}
