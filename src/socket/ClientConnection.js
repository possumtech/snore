import ModelAgent from "../agent/ModelAgent.js";
import ProjectAgent from "../agent/ProjectAgent.js";

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

	constructor(ws, db, hooks) {
		this.#ws = ws;
		this.#db = db;
		this.#hooks = hooks;
		this.#projectAgent = new ProjectAgent(db, hooks);
		this.#modelAgent = new ModelAgent(db, hooks);

		this.#ws.on("message", (data) => this.#handleMessage(data));

		this.#setupNotifications();
	}

	#setupNotifications() {
		this.#hooks.ui.render.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				this.#sendNotification("ui/render", {
					text: payload.text,
					append: payload.append,
				});
			}
		});

		this.#hooks.ui.notify.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				this.#sendNotification("ui/notify", {
					text: payload.text,
					level: payload.level,
				});
			}
		});

		this.#hooks.editor.diff.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				this.#sendNotification("editor/diff", {
					runId: payload.runId,
					file: payload.file,
					patch: payload.patch,
				});
			}
		});
	}

	async handleMessageForTest(data) {
		return this.#handleMessage(data);
	}

	async #handleMessage(data) {
		let id = null;
		const debug = process.env.SNORE_DEBUG === "true";
		try {
			const rawMessage = await this.#hooks.socket.message.raw.filter(data);
			if (debug) console.log(`[SOCKET] IN: ${rawMessage.toString()}`);

			const message = JSON.parse(rawMessage.toString());

			const filteredRequest = await this.#hooks.rpc.request.filter(message);
			const { method, params, id: msgId } = filteredRequest;
			id = msgId;

			await this.#hooks.rpc.started.emit({
				method,
				params,
				id,
				sessionId: this.#context.sessionId,
			});

			let result;

			switch (method) {
				case "ping":
					result = {};
					break;

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
					if (!this.#context.projectPath)
						throw new Error("Project not initialized.");
					result = await this.#projectAgent.getFiles(this.#context.projectPath);
					break;

				case "updateFiles":
					if (!this.#context.projectId)
						throw new Error("Project not initialized.");
					result = await this.#projectAgent.updateFiles(
						this.#context.projectId,
						params.files,
					);
					break;

				case "startRun":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					result = await this.#projectAgent.startRun(
						this.#context.sessionId,
						params,
					);
					break;

				case "run/affirm":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					// Typically here we would commit files or finalize the state in the DB
					// For now, just mark the run as completed
					await this.#db.update_run_status.run({
						id: params.runId,
						status: "completed",
					});
					result = { status: "ok" };
					break;

				case "run/abort":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					// Typically here we would revert files or cancel the state in the DB
					await this.#db.update_run_status.run({
						id: params.runId,
						status: "aborted",
					});
					result = { status: "ok" };
					break;

				case "ask":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					result = await this.#projectAgent.ask(
						this.#context.sessionId,
						params.model,
						params.prompt,
						params.activeFiles || [],
						params.runId,
					);
					break;

				case "act":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					result = await this.#projectAgent.act(
						this.#context.sessionId,
						params.model,
						params.prompt,
						params.activeFiles || [],
						params.runId,
					);
					break;

				default:
					throw new Error(`Method '${method}' not found.`);
			}

			const finalResult = await this.#hooks.rpc.response.result.filter(result, {
				method,
				id,
			});

			this.#send({
				jsonrpc: "2.0",
				result: finalResult,
				id,
			});

			await this.#hooks.rpc.completed.emit({ method, id, result: finalResult });
		} catch (error) {
			if (debug) console.error(`[SOCKET] ERR: ${error.message}`);
			this.#send({
				jsonrpc: "2.0",
				error: { code: -32603, message: error.message },
				id: id || null,
			});
			await this.#hooks.rpc.error.emit({ id, error });
		}
	}

	#send(payload) {
		const debug = process.env.SNORE_DEBUG === "true";
		if (debug) {
			console.log(`[SOCKET] OUT: ${JSON.stringify(payload, null, 2)}`);
		}
		if (this.#ws.readyState === 1) {
			this.#ws.send(JSON.stringify(payload));
		}
	}

	#sendNotification(method, params) {
		this.#send({
			jsonrpc: "2.0",
			method,
			params,
		});
	}
}
