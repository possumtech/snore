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
			onError: ({ runId, loopId, turn, error }) =>
				hooks.error.log.emit({
					store: this.#entries,
					runId,
					turn,
					loopId,
					message: error.message,
					status: 413,
					attributes: { path: error.path, size: error.size },
				}),
			// Universal failure-rendering: every state→failed transition on
			// a non-error path fires error.log.emit so a sibling
			// log://turn_N/error/<slug> entry is created. The error plugin's
			// own #onErrorLog handler also writes state=failed on the error
			// entry; Entries.#fireFailed skips when path matches
			// log://turn_*/error/* so no recursion.
			onFailed: ({ runId, loopId, turn, sourcePath, body, outcome }) =>
				hooks.error.log.emit({
					store: this.#entries,
					runId,
					turn,
					loopId,
					message: body,
					attributes: { sourcePath, outcome },
				}),
		});
		this.#entries.loadSchemes(db);

		const turnExecutor = new TurnExecutor(db, this.#llm, hooks, this.#entries);
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

	async inject(run, message, mode, options = {}) {
		return this.#agentLoop.inject(run, message, mode, options);
	}

	// Create/fork the run row synchronously; caller follows up with ask/act.
	async ensureRun(projectId, model, run, prompt, options = {}) {
		return this.#agentLoop.ensureRun(projectId, model, run, prompt, options);
	}

	async getRunHistory(run) {
		return this.#agentLoop.getRunHistory(run);
	}

	abortRun(runId) {
		this.#agentLoop.abort(runId);
	}

	// Abort all in-flight runs and drain so the event loop can exit.
	async shutdown() {
		await this.#agentLoop.abortAll();
	}
}
