import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ProjectContext from "../../core/ProjectContext.js";
import RepoMap from "../../core/RepoMap.js";

export default class RepoMapPlugin {
	static register(hooks) {
		hooks.addEvent(
			"project_init_completed",
			async ({ projectId, projectPath, db }) => {
				if (!db) return;
				await RepoMapPlugin.#updateIndex(db, projectId, projectPath);
			},
		);

		hooks.addEvent(
			"files_update_completed",
			async ({ projectId, projectPath, db }) => {
				if (!db) return;
				await RepoMapPlugin.#updateIndex(db, projectId, projectPath);
			},
		);

		hooks.addEvent(
			"TURN_CONTEXT_FILES",
			async (slot, { project, activeFiles, db }) => {
				if (!project || !db) return;

				await RepoMapPlugin.#updateIndex(db, project.id, project.path);

				const visibilityMap = await RepoMapPlugin.#getVisibilityMap(
					db,
					project.id,
				);
				const ctx = await ProjectContext.open(project.path, visibilityMap);
				const repoMap = new RepoMap(ctx, db, project.id);

				const perspective = await repoMap.renderPerspective(activeFiles);

				for (const f of perspective.files) {
					const fileData = {
						path: f.path,
						symbols: f.symbols,
						mode: f.mode,
					};

					if (f.mode === "hot" && activeFiles.includes(f.path)) {
						const fullPath = join(project.path, f.path);
						if (existsSync(fullPath)) {
							fileData.content = readFileSync(fullPath, "utf8");
						}
					}

					slot.add(fileData, 10, `repomap:${f.path}`);
				}
			},
		);

		hooks.addEvent("TURN_SYSTEM_PROMPT", async (slot) => {
			slot.add("You are an assistant.", 5);
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
		for (const f of files) {
			map.set(f.path, f.visibility);
		}
		return map;
	}
}
