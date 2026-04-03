import { isAbsolute, relative } from "node:path";
import ProjectContext from "../fs/ProjectContext.js";
import LlmProvider from "../llm/LlmProvider.js";
import AgentLoop from "./AgentLoop.js";
import KnownStore from "./KnownStore.js";
import TurnExecutor from "./TurnExecutor.js";

export default class ProjectAgent {
	#db;
	#hooks;
	#agentLoop;
	#knownStore;
	#llm;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
		this.#llm = new LlmProvider(db);
		this.#knownStore = new KnownStore(db);

		const turnExecutor = new TurnExecutor(
			db,
			this.#llm,
			hooks,
			this.#knownStore,
		);
		this.#agentLoop = new AgentLoop(
			db,
			this.#llm,
			hooks,
			turnExecutor,
			this.#knownStore,
		);
	}

	async init(projectName, projectRoot, configPath) {
		await this.#hooks.project.init.started.emit({
			projectName,
			projectRoot,
		});

		const projectRow = await this.#db.upsert_project.get({
			name: projectName,
			project_root: projectRoot,
			config_path: configPath || null,
		});
		const projectId = projectRow.id;

		const { default: GitProvider } = await import("../fs/GitProvider.js");
		const gitRoot = await GitProvider.detectRoot(projectRoot);
		const headHash = gitRoot ? await GitProvider.getHeadHash(gitRoot) : null;

		const result = {
			projectId,
			context: { gitRoot, headHash },
		};

		await this.#hooks.project.init.completed.emit({
			...result,
			projectRoot,
			db: this.#db,
		});
		return result;
	}

	get store() {
		return this.#knownStore;
	}

	// --- File constraints ---

	async syncBuffered(projectId, files) {
		for (const path of files) {
			await this.#db.upsert_file_constraint.run({
				project_id: projectId,
				pattern: path,
				visibility: "active",
			});
		}
	}

	async getFiles(projectRoot) {
		const ctx = await ProjectContext.open(projectRoot);
		const mappable = await ctx.getMappableFiles();
		return mappable.map((path) => ({ path }));
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

	async activate(projectId, pattern, visibility = "active") {
		return this.#setConstraint(projectId, pattern, visibility);
	}

	async ignore(projectId, pattern) {
		return this.#setConstraint(projectId, pattern, "ignore");
	}

	async drop(projectId, pattern) {
		const path = await this.#normalizePath(projectId, pattern);
		if (!path) return { status: "ok" };

		await this.#db.delete_file_constraint.run({
			project_id: projectId,
			pattern: path,
		});

		return { status: "ok" };
	}

	async #normalizePath(projectId, path) {
		if (!isAbsolute(path)) return path;
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		if (!project) return path;
		return relative(project.project_root, path);
	}

	async #setConstraint(projectId, pattern, constraint) {
		const path = await this.#normalizePath(projectId, pattern);
		if (!path) return { status: "ok" };

		await this.#db.upsert_file_constraint.run({
			project_id: projectId,
			pattern: path,
			visibility: constraint,
		});

		if (constraint === "ignore") {
			const runs = await this.#db.get_all_runs.all({ project_id: projectId });
			for (const run of runs) {
				await this.#knownStore.demoteByPattern(run.id, path, null);
			}
		}

		return { status: "ok" };
	}

	// --- Run operations ---

	async ask(projectId, model, prompt, run = null, options = {}) {
		return this.#agentLoop.run(
			"ask",
			projectId,
			model,
			prompt,
			null,
			run,
			options,
		);
	}

	async act(projectId, model, prompt, run = null, options = {}) {
		return this.#agentLoop.run(
			"act",
			projectId,
			model,
			prompt,
			null,
			run,
			options,
		);
	}

	async resolve(run, resolution) {
		return this.#agentLoop.resolve(run, resolution);
	}

	async inject(run, message) {
		return this.#agentLoop.inject(run, message);
	}

	async getRunHistory(run) {
		return this.#agentLoop.getRunHistory(run);
	}

	abortRun(runId) {
		this.#agentLoop.abort(runId);
	}

	// --- Model info ---

	async getModelContextSize(model) {
		return this.#llm.getContextSize(model);
	}

	async getModelInfo(alias) {
		const resolved = await this.#llm.resolve(alias);
		const contextSize = await this.#llm.getContextSize(alias);
		return {
			alias,
			model: resolved,
			context_length: contextSize,
		};
	}
}
