import ProjectContext from "../../../domain/project/ProjectContext.js";
import RepoMap from "../../../domain/repomap/RepoMap.js";

export default class RepoMapPlugin {
	static register(hooks) {
		// Re-index on each turn (picks up file changes since last turn)
		hooks.onTurn(async (rummy) => {
			const { project, db } = rummy;
			if (!project?.path) return;
			if (rummy.noContext) return;

			const ctx = await ProjectContext.open(project.path);
			const repoMap = new RepoMap(ctx, db, project.id);
			await repoMap.updateIndex();
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
