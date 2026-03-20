import crypto from "node:crypto";
import ProjectContext from "../../domain/project/ProjectContext.js";

/**
 * SessionManager: Handles database state for Projects, Sessions, Runs, and Skills.
 */
export default class SessionManager {
	#db;
	#hooks;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
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

	async init(projectPath, projectName, clientId, projectBufferFiles = []) {
		await this.#hooks.project.init.started.emit({
			projectPath,
			projectName,
			clientId,
		});

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

		// Sync buffered files immediately
		await this.syncBuffered(projectId, projectBufferFiles);

		const { default: GitProvider } = await import(
			"../../infrastructure/filesystem/GitProvider.js"
		);
		const gitRoot = await GitProvider.detectRoot(projectPath);
		const headHash = gitRoot ? await GitProvider.getHeadHash(gitRoot) : null;

		const result = {
			projectId,
			sessionId,
			context: { gitRoot, headHash },
		};

		await this.#hooks.project.init.completed.emit({
			...result,
			projectPath,
			db: this.#db,
		});
		return result;
	}

	async syncBuffered(projectId, files) {
		await this.#db.reset_buffered.run({ project_id: projectId });
		for (const path of files) {
			await this.#db.set_buffered.run({ project_id: projectId, path });
		}
	}

	async getFiles(projectPath) {
		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		if (projects.length === 0) return [];
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
		await this.#hooks.project.files.update.started.emit({ projectId, files });

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
		await this.#hooks.project.files.update.completed.emit({
			projectId,
			projectPath: project.path,
			files,
			db: this.#db,
		});

		return { status: "ok" };
	}

	async startRun(sessionId, runConfig) {
		const runId = crypto.randomUUID();

		const config = await this.#hooks.run.config.filter(runConfig, {
			sessionId,
		});

		await this.#db.create_run.run({
			id: runId,
			session_id: sessionId,
			parent_run_id: config.parentRunId || null,
			type: config.type,
			config: JSON.stringify(config.config || {}),
		});

		await this.#hooks.run.started.emit({
			runId,
			sessionId,
			type: config.type,
		});
		return runId;
	}

	async setSystemPrompt(sessionId, systemPrompt) {
		await this.#db.update_session_system_prompt.run({
			id: sessionId,
			system_prompt: systemPrompt,
		});
	}

	async setPersona(sessionId, persona) {
		await this.#db.update_session_persona.run({ id: sessionId, persona });
	}

	async addSkill(sessionId, name) {
		await this.#db.insert_session_skill.run({ session_id: sessionId, name });
	}

	async removeSkill(sessionId, name) {
		await this.#db.delete_session_skill.run({ session_id: sessionId, name });
	}
}
