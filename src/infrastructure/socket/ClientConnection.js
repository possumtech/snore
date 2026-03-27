import ProjectAgent from "../../application/agent/ProjectAgent.js";
import ModelAgent from "../../application/model/ModelAgent.js";

export default class ClientConnection {
	#ws;
	#db;
	#projectAgent;
	#modelAgent;
	#hooks;
	#rpcRegistry;
	#context = {
		projectId: null,
		sessionId: null,
		projectPath: null,
	};

	constructor(ws, db, hooks) {
		this.#ws = ws;
		this.#db = db;
		this.#hooks = hooks;
		this.#rpcRegistry = hooks.rpc.registry;
		this.#projectAgent = new ProjectAgent(db, hooks);
		this.#modelAgent = new ModelAgent(db, hooks);

		this.#ws.on("message", (data) => this.#handleMessage(data));

		this.#setupNotifications();
	}

	#setupNotifications() {
		this.#hooks.run.progress.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				this.#sendNotification("run/progress", {
					runId: payload.runId,
					turn: payload.turn,
					status: payload.status,
				});
			}
		});

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

		this.#hooks.ui.prompt.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				this.#sendNotification("ui/prompt", {
					runId: payload.runId,
					findingId: payload.findingId,
					question: payload.question,
					options: payload.options,
				});
			}
		});

		this.#hooks.run.command.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				const method = payload.type === "env" ? "run/env" : "run/run";
				this.#sendNotification(method, {
					runId: payload.runId,
					findingId: payload.findingId,
					command: payload.command,
				});
			}
		});

		this.#hooks.run.step.completed.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				const turn = payload.turn.toJson();
				if (process.env.RUMMY_DEBUG === "true") {
					console.log(
						`[DEBUG] RPC OUT: run/step/completed. Errors: ${turn.errors.length}`,
					);
				}
				this.#sendNotification("run/step/completed", {
					runId: payload.runId,
					turn,
					files: payload.projectFiles,
				});
			}
		});

		this.#hooks.editor.diff.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				this.#sendNotification("editor/diff", {
					runId: payload.runId,
					findingId: payload.findingId,
					type: payload.type,
					file: payload.file,
					patch: payload.patch,
					warning: payload.warning,
					error: payload.error,
				});
			}
		});
	}

	#buildHandlerContext() {
		return {
			projectAgent: this.#projectAgent,
			modelAgent: this.#modelAgent,
			db: this.#db,
			rpcRegistry: this.#rpcRegistry,
			projectId: this.#context.projectId,
			sessionId: this.#context.sessionId,
			projectPath: this.#context.projectPath,
			setContext: (projectId, sessionId, projectPath) => {
				this.#context.projectId = projectId;
				this.#context.sessionId = sessionId;
				this.#context.projectPath = projectPath;
			},
		};
	}

	async handleMessageForTest(data) {
		return this.#handleMessage(data);
	}

	async #handleMessage(data) {
		let id = null;
		const debug = process.env.RUMMY_DEBUG === "true";
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

			// rpc/discover is an alias for discover
			const resolvedMethod = method === "rpc/discover" ? "discover" : method;
			const registration = this.#rpcRegistry.get(resolvedMethod);
			if (!registration) throw new Error(`Method '${method}' not found.`);

			if (registration.requiresInit && !this.#context.sessionId) {
				throw new Error("Project not initialized.");
			}

			const result = await registration.handler(
				params || {},
				this.#buildHandlerContext(),
			);

			const finalResult = await this.#hooks.rpc.response.result.filter(result, {
				method,
				id,
			});

			this.#send({
				jsonrpc: "2.0",
				result: finalResult,
				id,
			});

			await this.#hooks.rpc.completed.emit({
				method,
				id,
				result: finalResult,
			});
		} catch (error) {
			if (debug) {
				console.error(`[SOCKET] ERR: ${error.message}`);
				console.error(`[DEBUG] Stack: ${error.stack}`);
			}
			this.#send({
				jsonrpc: "2.0",
				error: { code: -32603, message: error.message },
				id: id || null,
			});
			await this.#hooks.rpc.error.emit({ id, error });
		}
	}

	#send(payload) {
		const debug = process.env.RUMMY_DEBUG === "true";
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
