import LlmProvider from "../../domain/llm/LlmProvider.js";
import TurnBuilder from "../../domain/turn/TurnBuilder.js";
import SessionManager from "../session/SessionManager.js";
import AgentLoop from "./AgentLoop.js";
import FindingsManager from "./FindingsManager.js";
import FindingsProcessor from "./FindingsProcessor.js";
import ResponseParser from "./ResponseParser.js";
import StateEvaluator from "./StateEvaluator.js";
import TurnExecutor from "./TurnExecutor.js";

/**
 * ProjectAgent: Primary entry point and coordinator for the outside world.
 * Delegates specialized tasks to focused managers.
 */
export default class ProjectAgent {
	#db;
	#hooks;
	#sessionManager;
	#agentLoop;
	#findingsManager;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
		this.#sessionManager = new SessionManager(db, hooks);

		const parser = new ResponseParser();
		const llm = new LlmProvider(hooks);
		const turnBuilder = new TurnBuilder(hooks);
		this.#findingsManager = new FindingsManager(db);

		const turnExecutor = new TurnExecutor(db, llm, hooks, turnBuilder, parser);
		const findingsProcessor = new FindingsProcessor(
			db,
			this.#findingsManager,
			hooks,
		);
		const stateEvaluator = new StateEvaluator(db, hooks);

		this.#agentLoop = new AgentLoop(
			db,
			llm,
			hooks,
			turnExecutor,
			findingsProcessor,
			stateEvaluator,
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

	async ask(sessionId, model, prompt, runId = null, options = {}) {
		return this.#agentLoop.run(
			"ask",
			sessionId,
			model,
			prompt,
			null,
			runId,
			options,
		);
	}

	async act(sessionId, model, prompt, runId = null, options = {}) {
		return this.#agentLoop.run(
			"act",
			sessionId,
			model,
			prompt,
			null,
			runId,
			options,
		);
	}

	async resolve(runId, resolution) {
		return this.#agentLoop.resolve(runId, resolution);
	}

	async getRunHistory(runId) {
		return this.#agentLoop.getRunHistory(runId);
	}
}
