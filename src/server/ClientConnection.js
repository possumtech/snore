import msg from "../agent/messages.js";
import ProjectAgent from "../agent/ProjectAgent.js";

export default class ClientConnection {
	#ws;
	#db;
	#projectAgent;
	#hooks;
	#rpcRegistry;
	#rpcLogPending = new Map();
	#shutdownPromise = null;
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
		this.#ws.on("close", () => {
			// Fire-and-forget: the Promise is cached by `shutdown()` so
			// server-initiated close can await the same work.
			this.shutdown().catch((err) => {
				console.warn(`[RUMMY] shutdown on ws close failed: ${err.message}`);
			});
		});

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

	#onProposal = (payload) => {
		if (payload.projectId === this.#context.projectId) {
			this.#sendNotification("run/proposal", {
				run: payload.run,
				proposed: payload.proposed,
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

	#onStreamCancelled = (payload) => {
		if (payload.projectId === this.#context.projectId) {
			this.#sendNotification("stream/cancelled", {
				run: payload.run,
				path: payload.path,
				reason: payload.reason,
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
				telemetry: payload.telemetry,
			});
		}
	};

	#setupNotifications() {
		this.#hooks.run.progress.on(this.#onProgress);
		this.#hooks.proposal.pending.on(this.#onProposal);
		this.#hooks.ui.render.on(this.#onRender);
		this.#hooks.ui.notify.on(this.#onNotify);
		this.#hooks.run.state.on(this.#onState);
		this.#hooks.stream.cancelled.on(this.#onStreamCancelled);
	}

	#teardown() {
		this.#hooks.run.progress.off(this.#onProgress);
		this.#hooks.proposal.pending.off(this.#onProposal);
		this.#hooks.ui.render.off(this.#onRender);
		this.#hooks.ui.notify.off(this.#onNotify);
		this.#hooks.run.state.off(this.#onState);
		this.#hooks.stream.cancelled.off(this.#onStreamCancelled);
	}

	/**
	 * Abort in-flight runs on this connection and wait for them to
	 * settle. Idempotent: `ws.on("close")` and server-initiated close
	 * both call this; the cached Promise guarantees the work happens
	 * exactly once and both callers observe the same completion.
	 */
	shutdown() {
		if (!this.#shutdownPromise) {
			this.#shutdownPromise = (async () => {
				await this.#projectAgent.shutdown();
				this.#teardown();
				if (this.#ws.readyState === 1) this.#ws.terminate();
			})();
		}
		return this.#shutdownPromise;
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
		try {
			const rawMessage = await this.#hooks.socket.message.raw.filter(data);
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

			const logRow = await this.#db.log_rpc_call.get({
				project_id: this.#context.projectId,
				method,
				rpc_id: id,
				params: params ? JSON.stringify(params) : null,
			});
			if (logRow) this.#rpcLogPending.set(id, logRow.id);

			const resolvedMethod = method === "rpc/discover" ? "discover" : method;
			const registration = this.#rpcRegistry.get(resolvedMethod);
			if (!registration)
				throw new Error(msg("error.method_not_found", { method }));

			if (registration.requiresInit && !this.#context.projectId) {
				throw new Error(msg("error.not_initialized"));
			}

			// JSON-RPC requests may omit `params` entirely.
			const handlerParams = params === undefined ? {} : params;
			let result;
			if (registration.longRunning) {
				result = await registration.handler(
					handlerParams,
					this.#buildHandlerContext(),
				);
			} else {
				const timeout = Number(process.env.RUMMY_RPC_TIMEOUT);
				let timer;
				result = await Promise.race([
					registration.handler(handlerParams, this.#buildHandlerContext()),
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
				await this.#db.log_rpc_result.run({
					id: logId,
					result: finalResult
						? JSON.stringify(finalResult).slice(0, 4096)
						: null,
				});
			}
		} catch (error) {
			console.error(`[RUMMY] RPC Error: ${error.message}`);
			console.error(`[RUMMY] Stack: ${error.stack}`);
			// JSON-RPC: error responses for malformed requests with no id
			// MUST carry null per the spec.
			this.#send({
				jsonrpc: "2.0",
				error: { code: -32603, message: error.message },
				id: id === undefined ? null : id,
			});
			await this.#hooks.rpc.error.emit({ id, error });

			const errLogId = this.#rpcLogPending.get(id);
			if (errLogId) {
				this.#rpcLogPending.delete(id);
				await this.#db.log_rpc_error.run({
					id: errLogId,
					error: error.message,
				});
			}
		}
	}

	#send(payload) {
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
