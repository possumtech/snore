import crypto from "node:crypto";
import OpenRouterClient from "../core/OpenRouterClient.js";
import ProjectContext from "../core/ProjectContext.js";
import RepoMap from "../core/RepoMap.js";

export default class ProjectAgent {
	#db;
	#client;

	constructor(db) {
		this.#db = db;
		this.#client = new OpenRouterClient(process.env.OPENROUTER_API_KEY);
	}

	async #getVisibilityMap(projectId) {
		const files = await this.#db.get_project_repo_map.all({
			project_id: projectId,
		});
		const map = new Map();
		for (const f of files) {
			map.set(f.path, f.visibility);
		}
		return map;
	}

	async init(projectPath, projectName, clientId) {
		const actualProjectId = crypto.randomUUID();
		const sessionId = crypto.randomUUID();

		await this.#db.upsert_project.run({
			id: actualProjectId,
			path: projectPath,
			name: projectName,
		});

		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		const projectId = projects[0].id;

		const visibilityMap = await this.#getVisibilityMap(projectId);
		const ctx = await ProjectContext.open(projectPath, visibilityMap);
		const repoMap = new RepoMap(ctx, this.#db, projectId);
		await repoMap.updateIndex();

		await this.#db.create_session.run({
			id: sessionId,
			project_id: projectId,
			client_id: clientId,
		});

		return { projectId, sessionId };
	}

	async getFiles(projectPath) {
		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		const visibilityMap = await this.#getVisibilityMap(projects[0].id);
		const ctx = await ProjectContext.open(projectPath, visibilityMap);
		const mappable = await ctx.getMappableFiles();
		const results = [];
		for (const relPath of mappable) {
			results.push({ path: relPath, state: await ctx.resolveState(relPath) });
		}
		return results;
	}

	async updateFiles(projectId, files) {
		for (const f of files) {
			await this.#db.upsert_repo_map_file.run({
				project_id: projectId,
				path: f.path,
				visibility: f.visibility,
				hash: null,
				size: 0,
			});
		}

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		const visibilityMap = await this.#getVisibilityMap(projectId);
		const ctx = await ProjectContext.open(project.path, visibilityMap);
		const repoMap = new RepoMap(ctx, this.#db, projectId);
		await repoMap.updateIndex();

		return { status: "ok" };
	}

	async startJob(sessionId, jobConfig) {
		const jobId = crypto.randomUUID();
		await this.#db.create_job.run({
			id: jobId,
			session_id: sessionId,
			parent_job_id: jobConfig.parentJobId || null,
			type: jobConfig.type,
			config: JSON.stringify(jobConfig.config || {}),
		});
		return jobId;
	}

	async ask(sessionId, model, prompt, activeFiles = []) {
		const sessions = await this.#db.get_session_by_id.all({ id: sessionId });
		const project = await this.#db.get_project_by_id.get({
			id: sessions[0].project_id,
		});
		const jobId = crypto.randomUUID();

		await this.#db.create_job.run({
			id: jobId,
			session_id: sessionId,
			type: "ask",
			config: JSON.stringify({ model, activeFiles }),
		});

		const visibilityMap = await this.#getVisibilityMap(project.id);
		const ctx = await ProjectContext.open(project.path, visibilityMap);
		const repoMap = new RepoMap(ctx, this.#db, project.id);
		await repoMap.updateIndex();

		const perspective = await repoMap.renderPerspective(activeFiles);

		const systemPrompt = `You are SNORE Agent. Project Map:\n\n${JSON.stringify(perspective, null, 2)}`;
		const messages = [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: prompt },
		];

		await this.#db.create_turn.run({
			job_id: jobId,
			sequence_number: 0,
			payload: JSON.stringify(messages),
			usage: null,
		});

		const targetModel = process.env[`SNORE_MODEL_${model}`] || model;
		const result = await this.#client.completion(messages, targetModel);

		const responseMessage = result.choices?.[0]?.message;
		await this.#db.create_turn.run({
			job_id: jobId,
			sequence_number: 1,
			payload: JSON.stringify(responseMessage),
			usage: JSON.stringify(result.usage),
		});

		await this.#db.update_job_status.run({ id: jobId, status: "completed" });

		return { jobId, response: responseMessage?.content };
	}
}
