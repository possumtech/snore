import ProjectContext from "../../../domain/project/ProjectContext.js";
import RepoMap from "../../../domain/repomap/RepoMap.js";

/**
 * RepoMapPlugin: Logic for mapping files and formatting them as DOM nodes.
 */
export default class RepoMapPlugin {
	static register(hooks) {
		hooks.onTurn(async (rummy) => {
			const { project, db } = rummy;
			if (!project?.path) return;

			// Fetch handlers and ranked files via RepoMap
			const files = await db.get_project_repo_map.all({
				project_id: project.id,
			});
			const visibilityMap = new Map();
			for (const f of files) {
				visibilityMap.set(f.path, f.visibility);
			}

			const ctx = await ProjectContext.open(project.path, visibilityMap);
			const repoMap = new RepoMap(ctx, db, project.id);
			const perspective = await repoMap.renderPerspective({
				sequence: rummy.sequence,
			});

			const filesContainer = rummy.tag("files");
			rummy.contextEl.appendChild(filesContainer);

			for (const f of perspective.files) {
				const fileEl = rummy.tag("file", {
					path: f.path,
					size: String(f.size ?? 0),
					tokens: String(f.tokens ?? 0),
				});

				if (f.symbols && f.symbols.length > 0) {
					const highDensitySymbols = f.symbols
						.map((s) => (s.params ? `${s.name}${s.params}` : s.name))
						.join("\t");
					fileEl.appendChild(rummy.tag("symbols", {}, [highDensitySymbols]));
				}

				if (f.content) {
					fileEl.appendChild(rummy.tag("source", {}, [f.content]));
				}

				filesContainer.appendChild(fileEl);
			}
		});

		// Trigger re-indexing on project init completion
		hooks.project.init.completed.on(async (payload) => {
			const { projectId, projectPath, db } = payload;
			const ctx = await ProjectContext.open(projectPath);
			const repoMap = new RepoMap(ctx, db, projectId);
			await repoMap.updateIndex();
		});

		// Trigger re-indexing on explicit file updates
		hooks.project.files.update.completed.on(async (payload) => {
			const { projectId, projectPath, db } = payload;
			const ctx = await ProjectContext.open(projectPath);
			const repoMap = new RepoMap(ctx, db, projectId);
			await repoMap.updateIndex();
		});
	}
}
