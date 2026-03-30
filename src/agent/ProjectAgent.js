import LlmProvider from "../llm/LlmProvider.js";
import AgentLoop from "./AgentLoop.js";
import KnownStore from "./KnownStore.js";
import SessionManager from "./SessionManager.js";
import TurnExecutor from "./TurnExecutor.js";

export default class ProjectAgent {
	#db;
	#hooks;
	#sessionManager;
	#agentLoop;
	#llm;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
		this.#sessionManager = new SessionManager(db, hooks);

		this.#llm = new LlmProvider(hooks, db);
		const llm = this.#llm;
		hooks.models = llm.capabilities;
		const knownStore = new KnownStore(db);

		const turnExecutor = new TurnExecutor(db, llm, hooks, knownStore);

		this.#agentLoop = new AgentLoop(
			db,
			llm,
			hooks,
			turnExecutor,
			knownStore,
			this.#sessionManager,
		);
	}

	async init(projectPath, projectName, clientId, projectBufferFiles = []) {
		return this.#sessionManager.init(
			projectPath,
			projectName,
			clientId,
			projectBufferFiles,
		);
	}

	async syncBuffered(projectId, files) {
		return this.#sessionManager.syncBuffered(projectId, files);
	}

	async getFiles(projectPath) {
		return this.#sessionManager.getFiles(projectPath);
	}

	async fileStatus(projectId, path) {
		return this.#sessionManager.fileStatus(projectId, path);
	}

	async drop(projectId, pattern) {
		return this.#sessionManager.drop(projectId, pattern);
	}

	async activate(projectId, pattern) {
		return this.#sessionManager.activate(projectId, pattern);
	}

	async readOnly(projectId, pattern) {
		return this.#sessionManager.readOnly(projectId, pattern);
	}

	async ignore(projectId, pattern) {
		return this.#sessionManager.ignore(projectId, pattern);
	}

	async startRun(sessionId, config) {
		return this.#sessionManager.startRun(sessionId, config);
	}

	async setSystemPrompt(sessionId, text) {
		return this.#sessionManager.setSystemPrompt(sessionId, text);
	}

	async setPersona(sessionId, text) {
		return this.#sessionManager.setPersona(sessionId, text);
	}

	async addSkill(sessionId, name) {
		return this.#sessionManager.addSkill(sessionId, name);
	}

	async removeSkill(sessionId, name) {
		return this.#sessionManager.removeSkill(sessionId, name);
	}

	async getSkills(sessionId) {
		return this.#sessionManager.getSkills(sessionId);
	}

	async setTemperature(sessionId, temperature) {
		return this.#sessionManager.setTemperature(sessionId, temperature);
	}

	async getTemperature(sessionId) {
		return this.#sessionManager.getTemperature(sessionId);
	}

	async setContextLimit(sessionId, limit) {
		return this.#sessionManager.setContextLimit(sessionId, limit);
	}

	async getContextLimit(sessionId) {
		return this.#sessionManager.getContextLimit(sessionId);
	}

	async getModelContextSize(model) {
		return this.#llm.getContextSize(model);
	}

	async ask(sessionId, model, prompt, run = null, options = {}) {
		return this.#agentLoop.run(
			"ask",
			sessionId,
			model,
			prompt,
			null,
			run,
			options,
		);
	}

	async act(sessionId, model, prompt, run = null, options = {}) {
		return this.#agentLoop.run(
			"act",
			sessionId,
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
