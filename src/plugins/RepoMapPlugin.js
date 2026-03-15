import ProjectContext from "../core/ProjectContext.js";
import RepoMap from "../core/RepoMap.js";

export default class RepoMapPlugin {
	static register(hooks) {
		hooks.addAction(
			"project_initialized",
			async ({ projectId, projectPath, db }) => {
				if (!db) return;
				await RepoMapPlugin.#updateIndex(db, projectId, projectPath);
			},
		);

		hooks.addAction("files_updated", async ({ projectId, projectPath, db }) => {
			if (!db) return;
			await RepoMapPlugin.#updateIndex(db, projectId, projectPath);
		});

		hooks.addFilter(
			"system_prompt",
			async (prompt, { project, activeFiles, db }) => {
				if (!project || !db) return prompt;

				// Ensure the index is fresh before an ask
				await RepoMapPlugin.#updateIndex(db, project.id, project.path);

				const visibilityMap = await RepoMapPlugin.#getVisibilityMap(
					db,
					project.id,
				);
				const ctx = await ProjectContext.open(project.path, visibilityMap);
				const repoMap = new RepoMap(ctx, db, project.id);

				const perspective = await repoMap.renderPerspective(activeFiles);
				const mapString = JSON.stringify(perspective, null, 2);

				return `${prompt}\n\nProject Map:\n\n${mapString}`;
			},
			50,
		); // Priority 50 ensures it runs after basic prompt setup
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
		for (const f of files) {
			map.set(f.path, f.visibility);
		}
		return map;
	}
}
