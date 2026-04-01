import msg from "../../agent/messages.js";

export default class CoreRpcPlugin {
	static register(hooks) {
		const r = hooks.rpc.registry;

		r.register("ping", {
			handler: async () => ({}),
			description: "Liveness check. Returns {}.",
		});

		r.register("discover", {
			handler: async (_params, ctx) => ctx.rpcRegistry.discover(),
			description: "Returns { methods, notifications } catalog.",
		});

		r.register("init", {
			handler: async (params, ctx) => {
				const result = await ctx.projectAgent.init(
					params.projectPath,
					params.projectName,
					params.clientId,
					params.projectBufferFiles || [],
				);
				ctx.setContext(result.projectId, result.sessionId, params.projectPath);
				return result;
			},
			description:
				"Initialize project session. Returns { projectId, sessionId, context }.",
			params: {
				projectPath: "string — absolute path",
				projectName: "string — display name",
				clientId: "string — unique client ID",
				projectBufferFiles: "string[] — open files in IDE (optional)",
			},
		});

		r.register("getModels", {
			handler: async (_params, ctx) => ctx.modelAgent.getModels(),
			description:
				"List available model aliases. Returns [{ alias, actual, display, default }].",
		});

		r.register("getModelInfo", {
			handler: async (params, ctx) => {
				return ctx.projectAgent.getModelInfo(
					ctx.sessionId,
					params.model || process.env.RUMMY_MODEL_DEFAULT,
				);
			},
			description:
				"Get model metadata and context sizing. Returns { alias, model, context_length, limit, effective, name, max_completion_tokens }.",
			params: {
				model: "string? — model alias, defaults to RUMMY_MODEL_DEFAULT",
			},
			requiresInit: true,
		});

		r.register("getFiles", {
			handler: async (_params, ctx) =>
				ctx.projectAgent.getFiles(ctx.projectPath),
			description:
				"List project files with fidelity. Returns [{ path, fidelity, size }].",
			requiresInit: true,
		});

		r.register("fileStatus", {
			handler: async (params, ctx) =>
				ctx.projectAgent.fileStatus(ctx.projectId, params.pattern),
			description:
				"File state in the known store. Accepts regex pattern. Returns [{ path, state, turn }].",
			params: { pattern: "string — file path or regex pattern" },
			requiresInit: true,
		});

		r.register("activate", {
			handler: async (params, ctx) =>
				ctx.projectAgent.activate(ctx.projectId, params.pattern),
			description: "Set file to full fidelity (editable).",
			params: { pattern: "string — file path or glob" },
			requiresInit: true,
		});

		r.register("readOnly", {
			handler: async (params, ctx) =>
				ctx.projectAgent.readOnly(ctx.projectId, params.pattern),
			description: "Set file to full:readonly fidelity.",
			params: { pattern: "string — file path or glob" },
			requiresInit: true,
		});

		r.register("ignore", {
			handler: async (params, ctx) =>
				ctx.projectAgent.ignore(ctx.projectId, params.pattern),
			description: "Exclude file from model context.",
			params: { pattern: "string — file path or glob" },
			requiresInit: true,
		});

		r.register("drop", {
			handler: async (params, ctx) =>
				ctx.projectAgent.drop(ctx.projectId, params.pattern),
			description: "Remove file state override. File reverts to default.",
			params: { pattern: "string — file path or glob" },
			requiresInit: true,
		});

		r.register("startRun", {
			handler: async (params, ctx) => {
				const result = await ctx.projectAgent.startRun(ctx.sessionId, params);
				return { run: result.alias };
			},
			description: "Pre-create a run. Returns { run }.",
			params: {
				model: "string — optional model override",
				projectBufferFiles: "string[] — open files in IDE",
			},
			requiresInit: true,
		});

		r.register("ask", {
			handler: async (params, ctx) => {
				if (params.projectBufferFiles && ctx.projectId) {
					await ctx.projectAgent.syncBuffered(
						ctx.projectId,
						params.projectBufferFiles,
					);
				}
				return ctx.projectAgent.ask(
					ctx.sessionId,
					params.model,
					params.prompt,
					params.run,
					{
						temperature: params.temperature,
						noContext: params.noContext,
						fork: params.fork,
					},
				);
			},
			description: "Non-mutating query. Returns { run, status, turn }.",
			longRunning: true,
			params: {
				prompt: "string — user message",
				model: "string — model alias",
				run: "string — continue existing run",
				noContext: "boolean — skip file map (Lite mode)",
				fork: "boolean — branch from run history",
			},
			requiresInit: true,
		});

		r.register("act", {
			handler: async (params, ctx) => {
				if (params.projectBufferFiles && ctx.projectId) {
					await ctx.projectAgent.syncBuffered(
						ctx.projectId,
						params.projectBufferFiles,
					);
				}
				return ctx.projectAgent.act(
					ctx.sessionId,
					params.model,
					params.prompt,
					params.run,
					{
						temperature: params.temperature,
						noContext: params.noContext,
						fork: params.fork,
					},
				);
			},
			description:
				"Mutating directive. Returns { run, status, turn, proposed? }.",
			longRunning: true,
			params: {
				prompt: "string — user message",
				model: "string — model alias",
				run: "string — continue existing run",
				noContext: "boolean — skip file map (Lite mode)",
				fork: "boolean — branch from run history",
			},
			requiresInit: true,
		});

		r.register("run/resolve", {
			handler: async (params, ctx) =>
				ctx.projectAgent.resolve(params.run, params.resolution),
			description: "Resolve a proposed entry. Returns { run, status }.",
			longRunning: true,
			params: {
				run: "string — run name",
				resolution:
					"{ path: string, action: 'accept'|'reject', output?: string }",
			},
			requiresInit: true,
		});

		r.register("run/abort", {
			handler: async (params, ctx) => {
				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow)
					throw new Error(msg("error.run_not_found", { runId: params.run }));
				// Signal the in-flight loop to stop
				ctx.projectAgent.abortRun(runRow.id);
				await ctx.db.update_run_status.run({
					id: runRow.id,
					status: "aborted",
				});
				return { status: "ok" };
			},
			description: "Abort run. Stops in-flight turns immediately.",
			params: { run: "string — run name" },
			requiresInit: true,
		});

		r.register("run/rename", {
			handler: async (params, ctx) => {
				const { run, name } = params;
				if (!name || !/^[a-zA-Z0-9_]+$/.test(name)) {
					throw new Error(msg("error.run_name_invalid"));
				}
				const runRow = await ctx.db.get_run_by_alias.get({ alias: run });
				if (!runRow)
					throw new Error(msg("error.run_not_found", { runId: run }));
				try {
					await ctx.db.rename_run.run({
						id: runRow.id,
						old_alias: runRow.alias,
						new_alias: name,
					});
				} catch (err) {
					if (err.message.includes("UNIQUE")) {
						throw new Error(msg("error.run_name_taken", { name }));
					}
					throw err;
				}
				return { run: name };
			},
			description: "Rename a run. Must be unique, [a-zA-Z0-9_]+.",
			params: {
				run: "string — current run name",
				name: "string — new name, [a-zA-Z0-9_]+",
			},
			requiresInit: true,
		});

		r.register("run/inject", {
			handler: async (params, ctx) =>
				ctx.projectAgent.inject(params.run, params.message),
			description:
				"Inject a message into a run. If idle, resumes with the message as context. If active, queues it for the next turn.",
			longRunning: true,
			params: {
				run: "string — run name",
				message: "string — message to inject",
			},
			requiresInit: true,
		});

		r.register("getRuns", {
			handler: async (_params, ctx) => {
				const rows = await ctx.db.get_runs_by_session.all({
					session_id: ctx.sessionId,
				});
				return rows.map((r) => ({
					run: r.alias,
					type: r.type,
					status: r.status,
					turn: r.turn,
					summary: r.summary || "",
					created: r.created_at,
				}));
			},
			description:
				"List all runs for the current session with turn count and latest summary.",
			requiresInit: true,
		});

		r.register("getRun", {
			handler: async (params, ctx) => {
				const run = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!run)
					throw new Error(msg("error.run_not_found", { runId: params.run }));

				const [telemetry, reasoning, content, history, promptRow, summaryRow] =
					await Promise.all([
						ctx.db.get_run_usage.get({ run_id: run.id }),
						ctx.db.get_reasoning.all({ run_id: run.id }),
						ctx.db.get_content.all({ run_id: run.id }),
						ctx.db.get_history.all({ run_id: run.id }),
						ctx.db.get_latest_user_prompt.get({ run_id: run.id }),
						ctx.db.get_latest_summary.get({ run_id: run.id }),
					]);

				return {
					run: run.alias,
					turn: run.next_turn - 1,
					status: run.status,
					context: {
						telemetry: {
							prompt_tokens: telemetry.prompt_tokens,
							completion_tokens: telemetry.completion_tokens,
							total_tokens: telemetry.total_tokens,
							cost: telemetry.cost,
						},
						reasoning: reasoning.map((r) => ({
							path: r.path,
							value: r.value,
							turn: r.turn,
						})),
						content: content.map((c) => ({
							path: c.path,
							value: c.value,
							turn: c.turn,
						})),
						history: history.map((h) => {
							const scheme = h.path.split("://")[0];
							return {
								scheme,
								path: h.path,
								status: h.status,
								value: h.value,
								meta: h.meta ? JSON.parse(h.meta) : null,
								turn: h.turn,
							};
						}),
					},
					last_user_prompt: promptRow?.value || "",
					last_summary: summaryRow?.value || "",
				};
			},
			description:
				"Get full run detail: context (telemetry, reasoning, content, history), last_user_prompt, last_summary. History entries use scheme:// paths: prompt:// = human prompt, progress:// = automated continuation, content:// = assistant text, reasoning:// = model thinking, summary:// = turn summary, plus tool-specific schemes.",
			params: { run: "string — run alias" },
			requiresInit: true,
		});

		r.register("systemPrompt", {
			handler: async (params, ctx) => {
				await ctx.projectAgent.setSystemPrompt(ctx.sessionId, params.text);
				return { status: "ok" };
			},
			description: "Override the base system prompt for this session.",
			params: { text: "string" },
			requiresInit: true,
		});

		r.register("persona", {
			handler: async (params, ctx) => {
				await ctx.projectAgent.setPersona(ctx.sessionId, params.text);
				return { status: "ok" };
			},
			description: "Set agent persona for this session.",
			params: { text: "string" },
			requiresInit: true,
		});

		r.register("skill/add", {
			handler: async (params, ctx) => {
				await ctx.projectAgent.addSkill(ctx.sessionId, params.name);
				return { status: "ok" };
			},
			description: "Enable a named skill.",
			params: { name: "string" },
			requiresInit: true,
		});

		r.register("skill/remove", {
			handler: async (params, ctx) => {
				await ctx.projectAgent.removeSkill(ctx.sessionId, params.name);
				return { status: "ok" };
			},
			description: "Disable a named skill.",
			params: { name: "string" },
			requiresInit: true,
		});

		r.register("getSkills", {
			handler: async (_params, ctx) =>
				ctx.projectAgent.getSkills(ctx.sessionId),
			description: "List active skills. Returns string[].",
			requiresInit: true,
		});

		r.register("setTemperature", {
			handler: async (params, ctx) => {
				const value = await ctx.projectAgent.setTemperature(
					ctx.sessionId,
					Number(params.temperature),
				);
				return { temperature: value };
			},
			description:
				"Set session temperature (clamped 0-2). Returns { temperature }.",
			params: { temperature: "number — 0 to 2" },
			requiresInit: true,
		});

		r.register("getTemperature", {
			handler: async (_params, ctx) => {
				const value = await ctx.projectAgent.getTemperature(ctx.sessionId);
				return { temperature: value };
			},
			description:
				"Get session temperature. Returns { temperature } (null = env default).",
			requiresInit: true,
		});

		r.register("setContextLimit", {
			handler: async (params, ctx) => {
				const value = await ctx.projectAgent.setContextLimit(
					ctx.sessionId,
					params.limit ? Number(params.limit) : null,
				);
				return { context_limit: value };
			},
			description:
				"Override context window size (tokens). Clamps to min 1024. Pass null to reset to model default. Returns { context_limit }.",
			params: { limit: "number | null — token count, or null to reset" },
			requiresInit: true,
		});

		r.register("getContext", {
			handler: async (params, ctx) => {
				const model = params?.model || process.env.RUMMY_MODEL_DEFAULT;
				const limit = await ctx.projectAgent.getContextLimit(ctx.sessionId);
				let modelMax = null;
				try {
					modelMax = await ctx.projectAgent.getModelContextSize(model);
				} catch {}
				const effective = limit ? Math.min(limit, modelMax || limit) : modelMax;
				return { model_max: modelMax, limit, effective };
			},
			description:
				"Get context sizing. Returns { model_max (from provider), limit (session override or null), effective (actual size used) }.",
			params: {
				model: "string? — model alias, defaults to RUMMY_MODEL_DEFAULT",
			},
			requiresInit: true,
		});

		// Notifications
		r.registerNotification(
			"run/state",
			"Turn state update. Payload: { run, turn, status, summary, history[], unknowns[], proposed[], telemetry: { modelAlias, model, temperature, context_size, prompt_tokens, completion_tokens, total_tokens, cost, context_distribution[] } }. Schemes: prompt:// = human prompt, progress:// = automated continuation, content:// = assistant text, reasoning:// = model thinking.",
		);
		r.registerNotification(
			"run/progress",
			"Turn status. Payload: { run, turn, status: 'thinking'|'processing'|'retrying' }.",
		);
		r.registerNotification(
			"ui/render",
			"Streaming output. Payload: { text, append }.",
		);
		r.registerNotification(
			"ui/notify",
			"Toast notification. Payload: { text, level }.",
		);
	}
}
