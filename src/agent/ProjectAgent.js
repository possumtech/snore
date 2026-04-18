import LlmProvider from "../llm/LlmProvider.js";
import AgentLoop from "./AgentLoop.js";
import Repository from "./Repository.js";
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
		this.#llm = new LlmProvider(db, hooks);
		this.#knownStore = new Repository(db, {
			onChanged: (event) => hooks.entry.changed.emit(event).catch(() => {}),
		});
		this.#knownStore.loadSchemes(db);

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
			config_path: configPath ?? null,
		});
		const projectId = projectRow.id;

		await this.#hooks.project.init.completed.emit({
			projectId,
			projectRoot,
			db: this.#db,
		});

		return { projectId };
	}

	get entries() {
		return this.#knownStore;
	}

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
}
