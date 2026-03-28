import crypto from "node:crypto";
import { isAbsolute, relative } from "node:path";
import ProjectContext from "../../domain/project/ProjectContext.js";

export default class SessionManager {
	#db;
	#hooks;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
	}

	async #getPromotionMap(projectId) {
		const files = await this.#db.get_project_repo_map.all({
			project_id: projectId,
		});
		const map = new Map();
		for (const f of files) {
			if (!map.has(f.path)) {
				map.set(f.path, {
					client_constraint: f.client_constraint,
					has_agent_promotion: f.has_agent_promotion,
					has_editor_promotion: f.has_editor_promotion,
				});
			}
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
		await this.#db.reset_editor_promotions.run({ project_id: projectId });
		for (const path of files) {
			await this.#db.upsert_editor_promotion.run({
				project_id: projectId,
				path,
			});
		}
	}

	async getFiles(projectPath) {
		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		if (projects.length === 0) return [];
		const projectId = projects[0].id;

		const ctx = await ProjectContext.open(projectPath);
		const mappable = await ctx.getMappableFiles();

		// Also include files with client promotions that aren't in git
		const clientPromos = await this.#db.get_client_promotions.all({
			project_id: projectId,
		});
		const allPaths = new Set(mappable);
		for (const p of clientPromos) allPaths.add(p.path);

		const results = [];
		for (const relPath of allPaths) {
			results.push(await this.fileStatus(projectId, relPath));
		}
		return results;
	}

	async fileStatus(projectId, path) {
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		if (!project) throw new Error("Project not found");

		const dbFile = await this.#db.get_repo_map_file.get({
			project_id: projectId,
			path,
		});

		// Check client promotion directly (works even for unindexed files)
		const clientPromos = await this.#db.get_client_promotions.all({
			project_id: projectId,
		});
		const clientPromo = clientPromos.find((p) => p.path === path);

		let fidelity = "path";
		if (clientPromo?.constraint_type === "excluded") fidelity = "excluded";
		else if (clientPromo?.constraint_type === "full:readonly")
			fidelity = "full:readonly";
		else if (clientPromo?.constraint_type === "full") fidelity = "full";
		else if (dbFile?.has_agent_promotion) fidelity = "full";
		else if (dbFile?.has_editor_promotion) fidelity = "full:readonly";

		return {
			path,
			fidelity,
			client_constraint: clientPromo?.constraint_type || null,
			has_agent_promotion: !!dbFile?.has_agent_promotion,
			has_editor_promotion: !!dbFile?.has_editor_promotion,
			size: dbFile?.size || 0,
			last_indexed_at: dbFile?.last_indexed_at || null,
		};
	}

	async #normalizePath(projectId, path) {
		if (!isAbsolute(path)) return path;
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		if (!project) return path;
		return relative(project.path, path);
	}

	async activate(projectId, pattern) {
		const path = await this.#normalizePath(projectId, pattern);
		if (!path) return { status: "ok" };
		await this.#hooks.project.files.update.started.emit({
			projectId,
			pattern: path,
			constraint: "full",
		});

		await this.#db.upsert_client_promotion.run({
			project_id: projectId,
			path,
			constraint_type: "full",
		});
		await this.#db.upsert_repo_map_file.get({
			project_id: projectId,
			path,
			hash: null,
			size: null,
			symbol_tokens: 0,
		});

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		await this.#hooks.project.files.update.completed.emit({
			projectId,
			projectPath: project.path,
			pattern,
			constraint: "full",
			db: this.#db,
		});

		return { status: "ok" };
	}

	async readOnly(projectId, pattern) {
		const path = await this.#normalizePath(projectId, pattern);
		await this.#hooks.project.files.update.started.emit({
			projectId,
			pattern: path,
			constraint: "full:readonly",
		});

		await this.#db.upsert_client_promotion.run({
			project_id: projectId,
			path,
			constraint_type: "full:readonly",
		});
		await this.#db.upsert_repo_map_file.get({
			project_id: projectId,
			path,
			hash: null,
			size: null,
			symbol_tokens: 0,
		});

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		await this.#hooks.project.files.update.completed.emit({
			projectId,
			projectPath: project.path,
			pattern,
			constraint: "full:readonly",
			db: this.#db,
		});

		return { status: "ok" };
	}

	async ignore(projectId, pattern) {
		const path = await this.#normalizePath(projectId, pattern);
		await this.#hooks.project.files.update.started.emit({
			projectId,
			pattern: path,
			constraint: "excluded",
		});

		await this.#db.upsert_client_promotion.run({
			project_id: projectId,
			path,
			constraint_type: "excluded",
		});

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		await this.#hooks.project.files.update.completed.emit({
			projectId,
			projectPath: project.path,
			pattern,
			constraint: "excluded",
			db: this.#db,
		});

		return { status: "ok" };
	}

	async drop(projectId, pattern) {
		const path = await this.#normalizePath(projectId, pattern);
		await this.#hooks.project.files.update.started.emit({
			projectId,
			pattern: path,
			constraint: null,
		});

		await this.#db.delete_client_promotion.run({
			project_id: projectId,
			pattern: path,
		});

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
