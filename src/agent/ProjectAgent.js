import crypto from "node:crypto";
import ProjectContext from "../core/ProjectContext.js";
import RepoMap from "../core/RepoMap.js";

export default class ProjectAgent {
	#db;

	constructor(db) {
		this.#db = db;
	}

	async init(projectPath, projectName, clientId) {
		const projectId = crypto.randomUUID();
		const sessionId = crypto.randomUUID();

		// Use the prepared upsert_project method
		await this.#db.upsert_project.run({
			id: projectId,
			path: projectPath,
			name: projectName || projectPath.split("/").pop(),
		});

		// Use the prepared get_project_by_path method
		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});

		if (!projects || projects.length === 0) {
			throw new Error(`Failed to create/fetch project at ${projectPath}`);
		}

		const actualProjectId = projects[0].id;

		// Initialize RepoMap
		const ctx = await ProjectContext.open(projectPath);
		const repoMap = new RepoMap(ctx, this.#db, actualProjectId);
		await repoMap.updateIndex();

		// Use the prepared create_session method
		await this.#db.create_session.run({
			id: sessionId,
			project_id: actualProjectId,
			client_id: clientId,
		});

		return {
			projectId: actualProjectId,
			sessionId,
		};
	}

	async getFiles(projectPath) {
		const ctx = await ProjectContext.open(projectPath);
		const mappable = await ctx.getMappableFiles();
		const results = [];

		for (const relPath of mappable) {
			const state = await ctx.resolveState(relPath);
			results.push({
				path: relPath,
				state,
			});
		}

		return results;
	}

	async startJob(sessionId, jobConfig) {
		const jobId = crypto.randomUUID();

		// Use the prepared create_job method
		await this.#db.create_job.run({
			id: jobId,
			session_id: sessionId,
			parent_job_id: jobConfig.parentJobId || null,
			type: jobConfig.type || "orchestrator",
			config: JSON.stringify(jobConfig.config || {}),
		});

		return jobId;
	}
}
