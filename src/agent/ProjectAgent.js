import LlmProvider from "../llm/LlmProvider.js";
import AgentLoop from "./AgentLoop.js";
import Entries from "./Entries.js";
import TurnExecutor from "./TurnExecutor.js";

export default class ProjectAgent {
	#db;
	#hooks;
	#agentLoop;
	#entries;
	#llm;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
		this.#llm = new LlmProvider(db, hooks);
		this.#entries = new Entries(db, {
			onChanged: (event) => hooks.entry.changed.emit(event),
		});
		this.#entries.loadSchemes(db);

		const turnExecutor = new TurnExecutor(
			db,
			this.#llm,
			hooks,
			this.#entries,
		);
		this.#agentLoop = new AgentLoop(
			db,
			this.#llm,
			hooks,
			turnExecutor,
			this.#entries,
		);
	}

	async init(projectName, projectRoot, configPath = null) {
		await this.#hooks.project.init.started.emit({
			projectName,
			projectRoot,
		});

		const projectRow = await this.#db.upsert_project.get({
			name: projectName,
			project_root: projectRoot,
			config_path: configPath,
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
		return this.#entries;
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

	/**
	 * Abort every in-flight run and wait for them to settle. Called
	 * from the server's close path so the Node event loop isn't held
	 * open by detached kickoff Promises after shutdown.
	 */
	async shutdown() {
		await this.#agentLoop.abortAll();
	}
}
