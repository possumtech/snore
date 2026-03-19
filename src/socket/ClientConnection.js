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
		this.#hooks.run.progress.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				this.#sendNotification("run/progress", {
					runId: payload.runId,
					tasks: payload.tasks,
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

		this.#hooks.run.step.completed.on((payload) => {
			if (payload.sessionId === this.#context.sessionId) {
				this.#sendNotification("run/step/completed", {
					runId: payload.runId,
					turnXml: payload.turn.toXml(),
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

			let result;

			switch (method) {
				case "ping":
					result = {};
					break;

				case "rpc/discover":
					result = {
						methods: {
							ping: { description: "Check server liveness", params: {} },
							init: {
								description: "Initialize a project session",
								params: {
									projectPath: "Absolute path to project",
									projectName: "Display name",
									clientId: "Unique client identifier",
								},
							},
							getModels: { description: "Get available local and aliased models", params: {} },
							getFiles: { description: "List all files in the current project", params: {} },
							updateFiles: {
								description: "Update the visibility/indexing status of files",
								params: { files: "Array of { path, visibility }" },
							},
							startRun: {
								description: "Begin a new agent execution sequence",
								params: {
									model: "Optional override model",
									activeFiles: "Array of files to include in context",
									yolo: "Boolean for auto-affirmation",
								},
							},
							getRunHistory: {
								description: "Retrieve all turns for a specific run",
								params: { runId: "UUID of the run" },
							},
							ask: {
								description: "Send a non-mutating query to the agent",
								params: {
									prompt: "User message",
									model: "Optional override",
									activeFiles: "Files to include in context",
								},
							},
							act: {
								description: "Send a mutating directive to the agent (can propose edits)",
								params: {
									prompt: "User message",
									model: "Optional override",
									activeFiles: "Files to include in context",
								},
							},
							systemPrompt: { description: "Set the base system prompt override", params: { text: "XML/Text content" } },
							persona: { description: "Set the agent persona", params: { text: "Text content" } },
							"skill/add": { description: "Enable a skill for this session", params: { name: "Skill ID" } },
						},
						notifications: {
							"llm/request/started": "Triggered when a turn is built and sent to the LLM. Contains the full 'turnXml'.",
							"run/step/completed": "Triggered when a turn finishes. Contains the full 'turnXml' including response.",
							"run/progress": "Periodic updates on agent thoughts and task status.",
							"ui/render": "Fragments for streaming output UI.",
							"editor/diff": "Proposed file modifications.",
						},
					};
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
						throw new Error("Project not initialized.");
					result = await this.#projectAgent.startRun(
						this.#context.sessionId,
						params,
					);
					break;

				case "getRunHistory":
					result = await this.#projectAgent.getRunHistory(params.runId);
					break;

				case "run/affirm":
					if (!this.#context.sessionId)
						throw new Error("Project not initialized.");

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

				case "systemPrompt":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					await this.#projectAgent.setSystemPrompt(
						this.#context.sessionId,
						params.text,
					);
					result = { status: "ok" };
					break;

				case "persona":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					await this.#projectAgent.setPersona(
						this.#context.sessionId,
						params.text,
					);
					result = { status: "ok" };
					break;

				case "skill/add":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					await this.#projectAgent.addSkill(
						this.#context.sessionId,
						params.name,
					);
					result = { status: "ok" };
					break;

				case "skill/remove":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					await this.#projectAgent.removeSkill(
						this.#context.sessionId,
						params.name,
					);
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
