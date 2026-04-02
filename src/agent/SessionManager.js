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

	async init(projectPath, projectName, clientId, _projectBufferFiles = []) {
		await this.#hooks.project.init.started.emit({
			projectPath,
			projectName,
			clientId,
		});

		const projectRow = await this.#db.upsert_project.get({
			path: projectPath,
			name: projectName,
		});
		const projectId = projectRow.id;

		const sessionRow = await this.#db.create_session.get({
			project_id: projectId,
			client_id: clientId,
		});
		const sessionId = sessionRow.id;

		const { default: GitProvider } = await import("../fs/GitProvider.js");
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
		for (const path of files) {
			await this.#db.upsert_file_constraint.run({
				project_id: projectId,
				pattern: path,
				visibility: "active",
			});
		}
	}

	async getFiles(projectPath) {
		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		if (projects.length === 0) return [];
		const _projectId = projects[0].id;

		const ctx = await ProjectContext.open(projectPath);
		const mappable = await ctx.getMappableFiles();

		return mappable.map((path) => ({ path, fidelity: "path" }));
	}

	async fileStatus(projectId, pattern) {
		const path = await this.#normalizePath(projectId, pattern);
		const run = await this.#db.get_latest_run.get({ project_id: projectId });
		if (!run) return [];
		const rows = await this.#knownStore.getFileStatesByPattern(run.id, path);
		const constraints = await this.#db.get_file_constraints.all({
			project_id: projectId,
		});
		const constraintMap = new Map(
			constraints.map((c) => [c.pattern, c.visibility]),
		);
		return rows.map((r) => ({
			path: r.path,
			state: constraintMap.get(r.path) || r.state,
			turn: r.turn,
		}));
	}

	async #normalizePath(projectId, path) {
		if (!isAbsolute(path)) return path;
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		if (!project) return path;
		return relative(project.path, path);
	}

	async #setConstraint(projectId, pattern, constraint) {
		const path = await this.#normalizePath(projectId, pattern);
		if (!path) return { status: "ok" };

		await this.#hooks.project.files.update.started.emit({
			projectId,
			pattern: path,
			constraint,
		});

		await this.#db.upsert_file_constraint.run({
			project_id: projectId,
			pattern: path,
			visibility: constraint,
		});

		// ignore → demote across all runs so file leaves context immediately
		if (constraint === "ignore") {
			const runs = await this.#db.get_all_runs.all({ project_id: projectId });
			for (const run of runs) {
				await this.#knownStore.demoteByPattern(run.id, path, null);
			}
		}

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		await this.#hooks.project.files.update.completed.emit({
			projectId,
			projectPath: project.path,
			pattern: path,
			constraint,
			db: this.#db,
		});

		return { status: "ok" };
	}

	async activate(projectId, pattern) {
		return this.#setConstraint(projectId, pattern, "active");
	}

	async readOnly(projectId, pattern) {
		return this.#setConstraint(projectId, pattern, "readonly");
	}

	async ignore(projectId, pattern) {
		return this.#setConstraint(projectId, pattern, "ignore");
	}

	async drop(projectId, pattern) {
		const path = await this.#normalizePath(projectId, pattern);
		if (!path) return { status: "ok" };

		await this.#hooks.project.files.update.started.emit({
			projectId,
			pattern: path,
			visibility: null,
		});

		await this.#db.delete_file_constraint.run({
			project_id: projectId,
			pattern: path,
		});

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		await this.#hooks.project.files.update.completed.emit({
			projectId,
			projectPath: project.path,
			pattern: path,
			visibility: null,
			db: this.#db,
		});

		return { status: "ok" };
	}

	async startRun(sessionId, runConfig) {
		const config = await this.#hooks.run.config.filter(runConfig, {
			sessionId,
		});

		const modelAlias = config.model || process.env.RUMMY_MODEL_DEFAULT;
		const alias = `${modelAlias}_${Date.now()}`;

		const runRow = await this.#db.create_run.get({
			session_id: sessionId,
			parent_run_id: config.parentRunId || null,
			config: JSON.stringify(config.config || {}),
			alias,
		});
		const runId = runRow.id;

		await this.#hooks.run.started.emit({
			runId,
			alias,
			sessionId,
			type: config.type,
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
		const rows = await this.#db.get_session_skills.all({
			session_id: sessionId,
		});
		return rows.map((r) => r.name);
	}

	async setTemperature(sessionId, temperature) {
		const clamped = Math.max(0, Math.min(2, temperature));
		await this.#db.update_session_temperature.run({
			id: sessionId,
			temperature: clamped,
		});
		return clamped;
	}

	async getTemperature(sessionId) {
		const row = await this.#db.get_session_temperature.get({ id: sessionId });
		return row?.temperature ?? null;
	}

	async setContextLimit(sessionId, limit) {
		const clamped = limit ? Math.max(1024, Math.round(limit)) : null;
		await this.#db.update_session_context_limit.run({
			id: sessionId,
			context_limit: clamped,
		});
		return clamped;
	}

	async getContextLimit(sessionId) {
		const row = await this.#db.get_session_context_limit.get({ id: sessionId });
		return row?.context_limit ?? null;
	}
}
