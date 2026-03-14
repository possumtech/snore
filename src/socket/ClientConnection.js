import ModelAgent from "../agent/ModelAgent.js";
import ProjectAgent from "../agent/ProjectAgent.js";
import ProjectContext from "../core/ProjectContext.js";
import RepoMap from "../core/RepoMap.js";

export default class ClientConnection {
	#ws;
	#db;
	#projectAgent;
	#modelAgent;
	#context = {
		projectId: null,
		sessionId: null,
		projectPath: null,
	};

	constructor(ws, db) {
		this.#ws = ws;
		this.#db = db;
		this.#projectAgent = new ProjectAgent(db);
		this.#modelAgent = new ModelAgent(db);

		this.#ws.on("message", (data) => this.#handleMessage(data));
	}

	async #handleMessage(data) {
		try {
			const message = JSON.parse(data.toString());
			const { method, params, id } = message;

			let result;

			switch (method) {
				case "init":
					// params: { projectPath, projectName, clientId }
					result = await this.#projectAgent.init(
						params.projectPath,
						params.projectName,
						params.clientId,
					);
					this.#context.projectId = result.projectId;
					this.#context.sessionId = result.sessionId;
					this.#context.projectPath = params.projectPath;
					break;

				case "getModels":
					result = await this.#modelAgent.getModels();
					break;

				case "getFiles":
					if (!this.#context.projectPath) {
						throw new Error("Project not initialized. Call 'init' first.");
					}
					result = await this.#projectAgent.getFiles(this.#context.projectPath);
					break;

				case "startJob":
					if (!this.#context.sessionId) {
						throw new Error("Session not initialized. Call 'init' first.");
					}
					result = await this.#projectAgent.startJob(
						this.#context.sessionId,
						params,
					);
					break;

				default:
					throw new Error(`Method '${method}' not found.`);
			}

			this.#send({
				jsonrpc: "2.0",
				result,
				id,
			});
		} catch (error) {
			this.#send({
				jsonrpc: "2.0",
				error: { code: -32603, message: error.message },
				id: null,
			});
		}
	}

	#send(payload) {
		if (this.#ws.readyState === 1) {
			this.#ws.send(JSON.stringify(payload));
		}
	}
}
