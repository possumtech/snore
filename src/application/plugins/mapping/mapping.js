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
				const docEl = rummy.tag("document", { index: String(index++) });

				const sourceLabel = f.content
					? f.path
					: f.symbols?.length > 0
						? `${f.path} [signatures]`
						: `${f.path} [path only]`;

				docEl.appendChild(rummy.tag("source", {}, [sourceLabel]));

				if (f.content) {
					docEl.appendChild(rummy.tag("document_content", {}, [f.content]));
				} else if (f.symbols && f.symbols.length > 0) {
					const sigs = f.symbols
						.map((s) => (s.params ? `${s.name}${s.params}` : s.name))
						.join(", ");
					docEl.appendChild(rummy.tag("document_content", {}, [sigs]));
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
			const { projectId, projectPath, pattern, db } = payload;

			// If a specific file was activated that might not be git-tracked,
			// ensure it's discoverable by adding it to the DB before indexing.
			if (pattern && !pattern.includes("*") && !pattern.includes("?")) {
				const { existsSync } = await import("node:fs");
				const { join } = await import("node:path");
				if (existsSync(join(projectPath, pattern))) {
					await db.upsert_repo_map_file.get({
						project_id: projectId,
						path: pattern,
						hash: null,
						size: null,
						symbol_tokens: null,
					});
				}
			}

			const ctx = await ProjectContext.open(projectPath);
			const repoMap = new RepoMap(ctx, db, projectId);
			await repoMap.updateIndex();
		});
	}
}
