import crypto from "node:crypto";
import { isAbsolute, relative } from "node:path";
import ProjectContext from "../fs/ProjectContext.js";
import KnownStore from "./KnownStore.js";

export default class SessionManager {
	#db;
	#hooks;
	#knownStore;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
		this.#knownStore = new KnownStore(db);
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

		const { default: GitProvider } = await import(
			"../fs/GitProvider.js"
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
		// Buffer sync: mark client-active files across all active runs
		const runs = await this.#db.get_active_runs.all({ project_id: projectId });
		for (const run of runs) {
			for (const path of files) {
				await this.#knownStore.upsert(run.id, 0, path, "", "active");
			}
		}
	}

	async getFiles(projectPath) {
		const projects = await this.#db.get_project_by_path.all({ path: projectPath });
		if (projects.length === 0) return [];
		const projectId = projects[0].id;

		const ctx = await ProjectContext.open(projectPath);
		const mappable = await ctx.getMappableFiles();

		return mappable.map((path) => ({ path, fidelity: "path" }));
	}

	async fileStatus(projectId, path) {
		return { path, fidelity: "path" };
	}

	async #normalizePath(projectId, path) {
		if (!isAbsolute(path)) return path;
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		if (!project) return path;
		return relative(project.path, path);
	}

	async #setFileState(projectId, pattern, state) {
		const path = await this.#normalizePath(projectId, pattern);
		if (!path) return { status: "ok" };

		await this.#hooks.project.files.update.started.emit({
			projectId, pattern: path, constraint: state,
		});

		// Update across all active runs
		const runs = await this.#db.get_active_runs.all({ project_id: projectId });
		for (const run of runs) {
			await this.#knownStore.upsert(run.id, 0, path, "", state);
		}

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		await this.#hooks.project.files.update.completed.emit({
			projectId,
			projectPath: project.path,
			pattern,
			constraint: state,
			db: this.#db,
		});

		return { status: "ok" };
	}

	async activate(projectId, pattern) {
		return this.#setFileState(projectId, pattern, "active");
	}

	async readOnly(projectId, pattern) {
		return this.#setFileState(projectId, pattern, "readonly");
	}

	async ignore(projectId, pattern) {
		return this.#setFileState(projectId, pattern, "ignore");
	}

	async drop(projectId, pattern) {
		const path = await this.#normalizePath(projectId, pattern);
		if (!path) return { status: "ok" };

		await this.#hooks.project.files.update.started.emit({
			projectId, pattern: path, constraint: null,
		});

		// Remove file entry from all active runs
		const runs = await this.#db.get_active_runs.all({ project_id: projectId });
		for (const run of runs) {
			await this.#knownStore.remove(run.id, path);
		}

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		await this.#hooks.project.files.update.completed.emit({
			projectId,
			projectPath: project.path,
			pattern: path,
			constraint: null,
			db: this.#db,
		});

		return { status: "ok" };
	}

	async startRun(sessionId, runConfig) {
		const runId = crypto.randomUUID();
		const config = await this.#hooks.run.config.filter(runConfig, { sessionId });

		const modelAlias = config.model || process.env.RUMMY_MODEL_DEFAULT;
		const prefix = `${modelAlias}_`;
		const row = await this.#db.get_next_run_alias.get({ prefix });
		const alias = `${prefix}${row.next_seq}`;

		await this.#db.create_run.run({
			id: runId,
			session_id: sessionId,
			parent_run_id: config.parentRunId || null,
			type: config.type,
			config: JSON.stringify(config.config || {}),
			alias,
		});

		await this.#hooks.run.started.emit({
			runId, alias, sessionId, type: config.type,
		});
		return { runId, alias };
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

	async getSkills(sessionId) {
		const rows = await this.#db.get_session_skills.all({ session_id: sessionId });
		return rows.map((r) => r.name);
	}

	async setTemperature(sessionId, temperature) {
		const clamped = Math.max(0, Math.min(2, temperature));
		await this.#db.update_session_temperature.run({
			id: sessionId, temperature: clamped,
		});
		return clamped;
	}

	async getTemperature(sessionId) {
		const row = await this.#db.get_session_temperature.get({ id: sessionId });
		return row?.temperature ?? null;
	}
}
