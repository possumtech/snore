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
			});

			const filesContainer = rummy.tag("files");
			rummy.contextEl.appendChild(filesContainer);

			const fidelityLabel = (f) => {
				if (f.content) return "complete";
				if (f.symbols?.length > 0) return "symbols";
				return "unread";
			};

			for (const f of perspective.files) {
				const fileAttrs = {
					path: f.path,
					size: String(f.size ?? 0),
					visibility: fidelityLabel(f),
				};

				if (f.fidelity === "full:readonly") {
					fileAttrs["read-only"] = "true";
				}

				const fileEl = rummy.tag("file", fileAttrs);

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
