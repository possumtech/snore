import { isAbsolute, relative } from "node:path";

/**
 * File plugin: projections and constraints for filesystem entries.
 *
 * Bare file paths (src/app.js) have scheme=NULL in the DB because
 * schemeOf() only recognizes "://" patterns. The schemes table has
 * a "file" entry so v_model_context can JOIN via COALESCE(scheme, 'file').
 * This is the one exception to "every scheme has a plugin owner" —
 * the file plugin owns the NULL scheme through the "file" registry entry.
 */
export default class File {
	#core;

	constructor(core) {
		this.#core = core;
		// "file" scheme covers bare paths (scheme IS NULL in DB)
		core.registerScheme({ category: "data" });
		core.registerScheme({ name: "http", category: "data" });
		core.registerScheme({ name: "https", category: "data" });
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
	}

	full(entry) {
		return entry.body;
	}

	summary(entry) {
		return entry.body;
	}

	/**
	 * Set a project-level file constraint. Backbone operation —
	 * constraints are project config, not tool dispatch.
	 */
	static async setConstraint(db, projectId, pattern, visibility = "active") {
		const path = await normalizePath(db, projectId, pattern);
		if (!path) return null;

		await db.upsert_file_constraint.run({
			project_id: projectId,
			pattern: path,
			visibility,
		});

		return path;
	}

	/**
	 * Remove a project-level file constraint.
	 */
	static async dropConstraint(db, projectId, pattern) {
		const path = await normalizePath(db, projectId, pattern);
		if (!path) return null;

		await db.delete_file_constraint.run({
			project_id: projectId,
			pattern: path,
		});

		return path;
	}
}

async function normalizePath(db, projectId, path) {
	if (!isAbsolute(path)) return path;
	const project = await db.get_project_by_id.get({ id: projectId });
	if (!project) return path;
	return relative(project.project_root, path);
}
