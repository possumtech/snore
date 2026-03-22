import ProjectAgent from "../../application/agent/ProjectAgent.js";
import ModelAgent from "../../application/model/ModelAgent.js";

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
				const turn = payload.turn.toJson();
				this.#sendNotification("run/step/completed", {
					runId: payload.runId,
					turn,
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

				case "discover":
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
									projectBufferFiles: "Optional array of open files in IDE",
								},
							},
							getModels: {
								description: "Get available local and aliased models",
								params: {},
							},
							getFiles: {
								description: "List all files in the current project",
								params: {},
							},
							fileStatus: {
								description: "Get detailed status for a single file",
								params: { path: "Relative file path" },
							},
							updateFiles: {
								description: "Update the visibility/indexing status of files",
								params: { files: "Array of { path, visibility }" },
							},
							drop: {
								description: "Demote files matching a glob pattern to 'mappable'",
								params: { pattern: "Glob pattern (e.g. 'src/*.js' or '*')" },
							},
							startRun: {
								description: "Begin a new agent execution sequence",
								params: {
									model: "Optional override model",
									projectBufferFiles: "Array of files currently open in IDE",
									yolo: "Boolean for auto-affirmation",
								},
							},
							ask: {
								description: "Send a non-mutating query to the agent",
								params: {
									prompt: "User message",
									model: "Optional override",
									projectBufferFiles: "Files open in IDE",
								},
							},
							act: {
								description:
									"Send a mutating directive to the agent (can propose edits)",
								params: {
									prompt: "User message",
									model: "Optional override",
									projectBufferFiles: "Files open in IDE",
								},
							},
							run: {
								description: "Alias for 'act'. Execute a mutating directive.",
								params: {
									prompt: "User message",
									model: "Optional override",
									projectBufferFiles: "Files open in IDE",
								},
							},
							systemPrompt: {
								description: "Set the base system prompt override",
								params: { text: "XML/Text content" },
							},
							persona: {
								description: "Set the agent persona",
								params: { text: "Text content" },
							},
							"skill/add": {
								description: "Enable a skill for this session",
								params: { name: "Skill ID" },
							},
						},
						notifications: {
							"run/step/completed":
								"Triggered when a turn finishes. Contains the structured 'turn' object including response, context, and sequence.",
							"run/progress":
								"Periodic updates on agent thoughts and task status.",
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
						params.projectBufferFiles || [],
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

				case "fileStatus":
					if (!this.#context.projectId)
						throw new Error("Project not initialized.");
					result = await this.#projectAgent.fileStatus(
						this.#context.projectId,
						params.path,
					);
					break;

				case "updateFiles":
					if (!this.#context.projectId)
						throw new Error("Project not initialized.");
					result = await this.#projectAgent.updateFiles(
						this.#context.projectId,
						params.files,
					);
					break;

				case "drop":
					if (!this.#context.projectId)
						throw new Error("Project not initialized.");
					result = await this.#projectAgent.drop(
						this.#context.projectId,
						params.pattern,
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

				case "run/resolve":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");
					result = await this.#projectAgent.resolve(
						params.runId,
						params.resolution, // { category, id, action: 'accepted'|'rejected', answer: '...' }
					);
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

					if (params.projectBufferFiles && this.#context.projectId) {
						await this.#projectAgent.syncBuffered(
							this.#context.projectId,
							params.projectBufferFiles,
						);
					}

					result = await this.#projectAgent.ask(
						this.#context.sessionId,
						params.model,
						params.prompt,
						params.activeFiles || [],
						params.runId,
					);
					break;

				case "act":
				case "run":
					if (!this.#context.sessionId)
						throw new Error("Session not initialized.");

					if (params.projectBufferFiles && this.#context.projectId) {
						await this.#projectAgent.syncBuffered(
							this.#context.projectId,
							params.projectBufferFiles,
						);
					}

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
