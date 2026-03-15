import ModelAgent from "../agent/ModelAgent.js";
import ProjectAgent from "../agent/ProjectAgent.js";
import HookRegistry from "../core/HookRegistry.js";

export default class ClientConnection {
	#ws;
	#db;
	#projectAgent;
	#modelAgent;
	#hooks;
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
		this.#hooks = HookRegistry.instance;

		this.#ws.on("message", (data) => this.#handleMessage(data));
	}

	/**
	 * Exposed for testing purposes.
	 */
	async handleMessageForTest(data) {
		return this.#handleMessage(data);
	}

	async #handleMessage(data) {
		let id = null;
		try {
			// 1. Filter raw message data before parsing
			const rawMessage = await this.#hooks.applyFilters(
				"socket_message_raw",
				data,
			);

			const message = JSON.parse(rawMessage.toString());

			// 2. Filter parsed RPC request
			const {
				method,
				params,
				id: msgId,
			} = await this.#hooks.applyFilters("rpc_request", message);
			id = msgId;

			let result;

			switch (method) {
				case "init":
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

				case "getOpenRouterModels":
					result = await this.#modelAgent.getOpenRouterModels();
					break;

				case "getFiles":
					result = await this.#projectAgent.getFiles(this.#context.projectPath);
					break;

				case "updateFiles":
					result = await this.#projectAgent.updateFiles(
						this.#context.projectId,
						params.files,
					);
					break;

				case "startJob":
					result = await this.#projectAgent.startJob(
						this.#context.sessionId,
						params,
					);
					break;

				case "ask":
					result = await this.#projectAgent.ask(
						this.#context.sessionId,
						params.model,
						params.prompt,
						params.activeFiles || [],
					);
					break;

				default:
					throw new Error(`Method '${method}' not found.`);
			}

			// 3. Filter RPC result before sending
			const finalResult = await this.#hooks.applyFilters(
				"rpc_response_result",
				result,
				{ method, id },
			);

			this.#send({
				jsonrpc: "2.0",
				result: finalResult,
				id,
			});
		} catch (error) {
			this.#send({
				jsonrpc: "2.0",
				error: { code: -32603, message: error.message },
				id: id || null,
			});
		}
	}

	#send(payload) {
		if (this.#ws.readyState === 1) {
			this.#ws.send(JSON.stringify(payload));
		}
	}
}
