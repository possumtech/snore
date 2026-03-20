import LlmProvider from "../../domain/llm/LlmProvider.js";
import TurnBuilder from "../../domain/turn/TurnBuilder.js";
import SessionManager from "../session/SessionManager.js";
import AgentLoop from "./AgentLoop.js";
import FindingsManager from "./FindingsManager.js";
import ResponseParser from "./ResponseParser.js";

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
		this.#findingsManager = new FindingsManager(db, parser);

		this.#agentLoop = new AgentLoop(
			db,
			llm,
			hooks,
			turnBuilder,
			parser,
			this.#findingsManager,
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

	async updateFiles(projectId, files) {
		return this.#sessionManager.updateFiles(projectId, files);
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

	async ask(
		sessionId,
		model,
		prompt,
		_activeFiles = [],
		runId = null,
		projectBufferFiles = null,
	) {
		return this.#agentLoop.run(
			"ask",
			sessionId,
			model,
			prompt,
			projectBufferFiles,
			runId,
		);
	}

	async act(
		sessionId,
		model,
		prompt,
		_activeFiles = [],
		runId = null,
		projectBufferFiles = null,
	) {
		return this.#agentLoop.run(
			"act",
			sessionId,
			model,
			prompt,
			projectBufferFiles,
			runId,
		);
	}

	async resolve(runId, resolution) {
		return this.#agentLoop.resolve(runId, resolution);
	}
}
