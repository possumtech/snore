import ProjectContext from "../../core/ProjectContext.js";
import RepoMap from "../../core/RepoMap.js";

/**
 * RepoMapPlugin: Logic for mapping files and formatting them as DOM nodes.
 */
export default class RepoMapPlugin {
	static register(hooks) {
		// Lifecycle: Re-index on initialization
		hooks.project.init.completed.on(async ({ projectId, projectPath, db }) => {
			if (!db) return;
			await RepoMapPlugin.#updateIndex(db, projectId, projectPath);
		});

		// Pipeline: Inject file data into the DOM
		hooks.onTurn(async (rummy) => {
			const { project, activeFiles, db } = rummy;
			if (!project || !db) return;

			await RepoMapPlugin.#updateIndex(db, project.id, project.path);
			const visibilityMap = await RepoMapPlugin.#getVisibilityMap(
				db,
				project.id,
			);
			const ctx = await ProjectContext.open(project.path, visibilityMap);
			const repoMap = new RepoMap(ctx, db, project.id);
			const perspective = await repoMap.renderPerspective(activeFiles);

			const filesContainer = rummy.tag("files");
			rummy.contextEl.appendChild(filesContainer);

			for (const f of perspective.files) {
				const status = f.status || "mappable";
				const fileEl = rummy.tag("file", {
					path: f.path,
					status,
					size: String(f.size ?? 0),
					tokens: String(f.tokens ?? 0),
				});

				if (f.symbols && f.symbols.length > 0) {
					fileEl.appendChild(
						rummy.tag("symbols", {}, [JSON.stringify(f.symbols)]),
					);
				}

				if (f.status === "active" && f.content) {
					fileEl.appendChild(rummy.tag("source", {}, [f.content]));
				}

				filesContainer.appendChild(fileEl);
			}
		});
	}

	static async #updateIndex(db, projectId, projectPath) {
		const visibilityMap = await RepoMapPlugin.#getVisibilityMap(db, projectId);
		const ctx = await ProjectContext.open(projectPath, visibilityMap);
		const repoMap = new RepoMap(ctx, db, projectId);
		await repoMap.updateIndex();
	}

	static async #getVisibilityMap(db, projectId) {
		const files = await db.get_project_repo_map.all({ project_id: projectId });
		const map = new Map();
		for (const f of files) map.set(f.path, f.visibility);
		return map;
	}
}
