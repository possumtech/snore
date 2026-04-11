import msg from "../agent/messages.js";
import ProjectAgent from "../agent/ProjectAgent.js";

export default class ClientConnection {
	#ws;
	#db;
	#projectAgent;
	#hooks;
	#rpcRegistry;
	#rpcLogPending = new Map();
	#context = {
		projectId: null,
		projectRoot: null,
	};

	constructor(ws, db, hooks) {
		this.#ws = ws;
		this.#db = db;
		this.#hooks = hooks;
		this.#rpcRegistry = hooks.rpc.registry;
		this.#projectAgent = new ProjectAgent(db, hooks);

		this.#ws.on("message", (data) => this.#handleMessage(data));
		this.#ws.on("close", () => this.#teardown());

		this.#setupNotifications();
	}

	#onProgress = (payload) => {
		if (payload.projectId === this.#context.projectId) {
			this.#sendNotification("run/progress", {
				run: payload.run,
				turn: payload.turn,
				status: payload.status,
			});
		}
	};

	#onRender = (payload) => {
		if (payload.projectId === this.#context.projectId) {
			this.#sendNotification("ui/render", {
				text: payload.text,
				append: payload.append,
			});
		}
	};

	#onNotify = (payload) => {
		if (payload.projectId === this.#context.projectId) {
			this.#sendNotification("ui/notify", {
				text: payload.text,
				level: payload.level,
			});
		}
	};

	#onState = (payload) => {
		if (payload.projectId === this.#context.projectId) {
			this.#sendNotification("run/state", {
				run: payload.run,
				turn: payload.turn,
				status: payload.status,
				summary: payload.summary,
				history: payload.history,
				unknowns: payload.unknowns,
				proposed: payload.proposed,
				telemetry: payload.telemetry,
			});
		}
	};

	#setupNotifications() {
		this.#hooks.run.progress.on(this.#onProgress);
		this.#hooks.ui.render.on(this.#onRender);
		this.#hooks.ui.notify.on(this.#onNotify);
		this.#hooks.run.state.on(this.#onState);
	}

	#teardown() {
		this.#hooks.run.progress.off(this.#onProgress);
		this.#hooks.ui.render.off(this.#onRender);
		this.#hooks.ui.notify.off(this.#onNotify);
		this.#hooks.run.state.off(this.#onState);
	}

	#buildHandlerContext() {
		return {
			projectAgent: this.#projectAgent,
			db: this.#db,
			rpcRegistry: this.#rpcRegistry,
			projectId: this.#context.projectId,
			projectRoot: this.#context.projectRoot,
			setContext: (projectId, projectRoot) => {
				this.#context.projectId = projectId;
				this.#context.projectRoot = projectRoot;
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
				projectId: this.#context.projectId,
			});

			try {
				const logRow = await this.#db.log_rpc_call.get({
					project_id: this.#context.projectId ?? null,
					method,
					rpc_id: id,
					params: params ? JSON.stringify(params) : null,
				});
				if (logRow) this.#rpcLogPending.set(id, logRow.id);
			} catch {}

			const resolvedMethod = method === "rpc/discover" ? "discover" : method;
			const registration = this.#rpcRegistry.get(resolvedMethod);
			if (!registration)
				throw new Error(msg("error.method_not_found", { method }));

			if (registration.requiresInit && !this.#context.projectId) {
				throw new Error(msg("error.not_initialized"));
			}

			let result;
			if (registration.longRunning) {
				result = await registration.handler(
					params || {},
					this.#buildHandlerContext(),
				);
			} else {
				const timeout = Number(process.env.RUMMY_RPC_TIMEOUT) || 10_000;
				let timer;
				result = await Promise.race([
					registration.handler(params || {}, this.#buildHandlerContext()),
					new Promise((_, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new Error(
										msg("error.rpc_timeout", {
											method: resolvedMethod,
											timeout,
										}),
									),
								),
							timeout,
						);
					}),
				]).finally(() => clearTimeout(timer));
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

			await this.#hooks.rpc.completed.emit({
				method,
				id,
				result: finalResult,
			});

			const logId = this.#rpcLogPending.get(id);
			if (logId) {
				this.#rpcLogPending.delete(id);
				try {
					await this.#db.log_rpc_result.run({
						id: logId,
						result: finalResult
							? JSON.stringify(finalResult).slice(0, 4096)
							: null,
					});
				} catch {}
			}
		} catch (error) {
			console.error(`[RUMMY] RPC Error: ${error.message}`);
			console.error(`[RUMMY] Stack: ${error.stack}`);
			this.#send({
				jsonrpc: "2.0",
				error: { code: -32603, message: error.message },
				id: id || null,
			});
			await this.#hooks.rpc.error.emit({ id, error });

			const errLogId = this.#rpcLogPending.get(id);
			if (errLogId) {
				this.#rpcLogPending.delete(id);
				try {
					await this.#db.log_rpc_error.run({
						id: errLogId,
						error: error.message,
					});
				} catch {}
			}
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
