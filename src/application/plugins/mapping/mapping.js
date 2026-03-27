import ProjectContext from "../../../domain/project/ProjectContext.js";
import RepoMap from "../../../domain/repomap/RepoMap.js";

export default class RepoMapPlugin {
	static register(hooks) {
		hooks.onTurn(async (rummy) => {
			const { project, db } = rummy;
			if (!project?.path) return;
			if (rummy.noContext) return;

			const files = await db.get_project_repo_map.all({
				project_id: project.id,
				run_id: rummy.runId,
			});
			const dbFiles = new Set();
			for (const f of files) {
				dbFiles.add(f.path);
			}

			const ctx = await ProjectContext.open(project.path, dbFiles);
			const repoMap = new RepoMap(ctx, db, project.id);
			const perspective = await repoMap.renderPerspective({
				sequence: rummy.sequence,
				runId: rummy.runId,
				contextSize: rummy.contextSize,
			});

			const docsEl = rummy.tag("documents");
			let index = 1;

			for (const f of perspective.files) {
				const visibility = f.content
					? "full"
					: f.symbols?.length > 0
						? "symbols"
						: "path";
				const docEl = rummy.tag("document", {
					index: String(index++),
					visibility,
				});

				docEl.appendChild(rummy.tag("source", {}, [f.path]));

				if (f.content) {
					docEl.appendChild(rummy.tag("document_content", {}, [f.content]));
				} else if (f.symbols && f.symbols.length > 0) {
					docEl.appendChild(rummy.tag("document_content", {}, [f.symbols.join(", ")]));
				}

				docsEl.appendChild(docEl);
			}

			rummy.system.appendChild(docsEl);
		});

		hooks.project.init.completed.on(async (payload) => {
			const { projectId, projectPath, db } = payload;
			const ctx = await ProjectContext.open(projectPath);
			const repoMap = new RepoMap(ctx, db, projectId);
			await repoMap.updateIndex();
		});

		hooks.project.files.update.completed.on(async (payload) => {
			const { projectId, projectPath, db } = payload;
			const ctx = await ProjectContext.open(projectPath);
			const repoMap = new RepoMap(ctx, db, projectId);
			await repoMap.updateIndex();
		});
	}
}
