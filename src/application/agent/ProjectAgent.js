import createHooks from "../../domain/hooks/Hooks.js";
import LlmProvider from "../../domain/llm/LlmProvider.js";
import TurnBuilder from "../../domain/turn/TurnBuilder.js";
import AgentLoop from "./AgentLoop.js";
import FindingsManager from "./FindingsManager.js";
import ResponseParser from "./ResponseParser.js";
import SessionManager from "../session/SessionManager.js";

/**
 * ProjectAgent: Primary entry point and coordinator for the outside world.
 * Delegates specialized tasks to focused managers.
 */
export default class ProjectAgent {
	#sessionManager;
	#responseParser;
	#findingsManager;
	#agentLoop;

	constructor(db, hooks = createHooks()) {
		const llmProvider = new LlmProvider(hooks);
		const turnBuilder = new TurnBuilder(hooks);

		this.#sessionManager = new SessionManager(db, hooks);
		this.#responseParser = new ResponseParser();
		this.#findingsManager = new FindingsManager(db, this.#responseParser);

		this.#agentLoop = new AgentLoop(
			db,
			llmProvider,
			hooks,
			turnBuilder,
			this.#responseParser,
			this.#findingsManager,
		);
	}

	async init(projectPath, projectName, clientId) {
		return this.#sessionManager.init(projectPath, projectName, clientId);
	}

	async getFiles(projectPath) {
		return this.#sessionManager.getFiles(projectPath);
	}

	async updateFiles(projectId, files) {
		return this.#sessionManager.updateFiles(projectId, files);
	}

	async startRun(sessionId, runConfig) {
		return this.#sessionManager.startRun(sessionId, runConfig);
	}

	async getRunHistory(runId) {
		return this.#agentLoop.getRunHistory(runId);
	}

	async setSystemPrompt(sessionId, systemPrompt) {
		return this.#sessionManager.setSystemPrompt(sessionId, systemPrompt);
	}

	async setPersona(sessionId, persona) {
		return this.#sessionManager.setPersona(sessionId, persona);
	}

	async addSkill(sessionId, name) {
		return this.#sessionManager.addSkill(sessionId, name);
	}

	async removeSkill(sessionId, name) {
		return this.#sessionManager.removeSkill(sessionId, name);
	}

	async ask(sessionId, model, prompt, activeFiles = [], runId = null) {
		return this.#agentLoop.run(
			"ask",
			sessionId,
			model,
			prompt,
			activeFiles,
			runId,
		);
	}

	async act(sessionId, model, prompt, activeFiles = [], runId = null) {
		return this.#agentLoop.run(
			"act",
			sessionId,
			model,
			prompt,
			activeFiles,
			runId,
		);
	}

	async resolve(runId, resolution) {
		return this.#agentLoop.resolve(runId, resolution);
	}
}
