import crypto from "node:crypto";
import HookRegistry from "../core/HookRegistry.js";
import OpenRouterClient from "../core/OpenRouterClient.js";
import ProjectContext from "../core/ProjectContext.js";
import TurnBuilder from "../core/TurnBuilder.js";

export default class ProjectAgent {
	#db;
	#client;
	#hooks;
	#turnBuilder;

	constructor(db) {
		this.#db = db;
		this.#client = new OpenRouterClient(process.env.OPENROUTER_API_KEY);
		this.#hooks = HookRegistry.instance;
		this.#turnBuilder = new TurnBuilder();
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

		await this.#db.create_session.run({
			id: sessionId,
			project_id: projectId,
			client_id: clientId,
		});

		const result = { projectId, sessionId };
		await this.#hooks.doAction("project_initialized", {
			projectId,
			projectPath,
			db: this.#db,
		});
		return result;
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

		await this.#hooks.doAction("files_updated", {
			projectId,
			projectPath: project.path,
			files,
			db: this.#db,
		});
		return { status: "ok" };
	}

	async startJob(sessionId, jobConfig) {
		const jobId = crypto.randomUUID();

		const config = await this.#hooks.applyFilters("job_config", jobConfig, {
			sessionId,
		});

		await this.#db.create_job.run({
			id: jobId,
			session_id: sessionId,
			parent_job_id: config.parentJobId || null,
			type: config.type,
			config: JSON.stringify(config.config || {}),
		});

		await this.#hooks.doAction("job_started", {
			jobId,
			sessionId,
			type: config.type,
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

		const turnObj = await this.#turnBuilder.build({
			project,
			sessionId,
			prompt,
			model,
			activeFiles,
			db: this.#db,
		});

		const messages = turnObj.serialize();
		const finalMessages = await this.#hooks.applyFilters(
			"llm_messages",
			messages,
			{ model, sessionId, jobId },
		);

		await this.#db.create_turn.run({
			job_id: jobId,
			sequence_number: 0,
			payload: JSON.stringify(finalMessages),
			usage: null,
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		});

		const targetModel = process.env[`SNORE_MODEL_${model}`] || model;
		const result = await this.#client.completion(finalMessages, targetModel);

		const responseMessage = result.choices?.[0]?.message;

		const finalResponse = await this.#hooks.applyFilters(
			"llm_response",
			responseMessage,
			{ model, sessionId, jobId },
		);

		const usage = result.usage || {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		};

		// Ensure we pass 0 instead of undefined to satisfy SQLite NOT NULL
		await this.#db.create_turn.run({
			job_id: jobId,
			sequence_number: 1,
			payload: JSON.stringify(finalResponse),
			usage: JSON.stringify(usage),
			prompt_tokens: usage.prompt_tokens || 0,
			completion_tokens: usage.completion_tokens || 0,
			total_tokens: usage.total_tokens || 0,
		});

		await this.#db.update_job_status.run({ id: jobId, status: "completed" });

		if (responseMessage?.reasoning_content) {
			turnObj.assistant.reasoning.add(responseMessage.reasoning_content);
		}
		if (finalResponse?.content) {
			turnObj.assistant.content.add(finalResponse.content);
		}
		turnObj.assistant.meta.add(usage);

		await this.#hooks.doAction("ask_completed", {
			jobId,
			sessionId,
			model: targetModel,
			turn: turnObj,
			usage,
		});

		return { jobId, response: finalResponse?.content };
	}
}
