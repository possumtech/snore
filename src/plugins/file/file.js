import { isAbsolute, relative } from "node:path";

// Owns NULL scheme (bare paths) via the "file" registry entry; see plugin README.
export default class File {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({ category: "data" });
		core.on("visible", this.full.bind(this));
		core.on("summarized", this.summary.bind(this));
	}

	full(entry) {
		return entry.body;
	}

	summary() {
		return "";
	}

	static async setConstraint(db, projectId, pattern, visibility = "add") {
		const path = await normalizePath(db, projectId, pattern);
		if (!path) return null;

		await db.upsert_file_constraint.run({
			project_id: projectId,
			pattern: path,
			visibility,
		});

		return path;
	}

	static async dropConstraint(db, projectId, pattern) {
		const path = await normalizePath(db, projectId, pattern);
		if (!path) return null;

		await db.delete_file_constraint.run({
			project_id: projectId,
			pattern: path,
		});

		return path;
	}

	// True if any readonly constraint matches; called from set-accept gate.
	static async isReadonly(db, projectId, path) {
		const rows = await db.get_file_constraints.all({ project_id: projectId });
		const { hedmatch } = await import("./../hedberg/patterns.js");
		return rows.some(
			(r) => r.visibility === "readonly" && hedmatch(r.pattern, path),
		);
	}
}

async function normalizePath(db, projectId, path) {
	if (!isAbsolute(path)) return path;
	const project = await db.get_project_by_id.get({ id: projectId });
	if (!project) return path;
	return relative(project.project_root, path);
}
