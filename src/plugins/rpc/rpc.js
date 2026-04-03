import msg from "../../agent/messages.js";

export default class CoreRpcPlugin {
	static register(hooks) {
		const r = hooks.rpc.registry;

		// --- Protocol ---

		r.register("ping", {
			handler: async () => ({}),
			description: "Liveness check.",
		});

		r.register("discover", {
			handler: async (_params, ctx) => ctx.rpcRegistry.discover(),
			description: "Returns { methods, notifications } catalog.",
		});

		r.register("init", {
			handler: async (params, ctx) => {
				const result = await ctx.projectAgent.init(
					params.name,
					params.projectRoot,
					params.configPath,
				);
				ctx.setContext(result.projectId, params.projectRoot);
				return result;
			},
			description:
				"Initialize project. Returns { projectId, context: { gitRoot, headHash } }.",
			params: {
				name: "string — project name (unique identifier)",
				projectRoot: "string — absolute path to source code",
				configPath: "string? — path to rummy config directory",
			},
		});

		// --- Models ---

		r.register("getModels", {
			handler: async (_params, ctx) => {
				const rows = await ctx.db.get_models.all({});
				return rows.map((m) => ({
					alias: m.alias,
					actual: m.actual,
					context_length: m.context_length,
				}));
			},
			description:
				"List available models. Returns [{ alias, actual, context_length }].",
		});

		r.register("addModel", {
			handler: async (params, ctx) => {
				const row = await ctx.db.upsert_model.get({
					alias: params.alias,
					actual: params.actual,
					context_length: params.contextLength || null,
				});
				return { id: row.id, alias: params.alias };
			},
			description: "Add or update a model. Returns { id, alias }.",
			params: {
				alias: "string — short name for the model",
				actual: "string — provider/model identifier (e.g. openai/gpt-5.4)",
				contextLength: "number? — context window size in tokens",
			},
		});

		r.register("removeModel", {
			handler: async (params, ctx) => {
				await ctx.db.delete_model.run({ alias: params.alias });
				return { status: "ok" };
			},
			description: "Remove a model by alias.",
			params: { alias: "string — model alias to remove" },
		});

		// --- File constraints ---

		r.register("read", {
			handler: async (params, ctx) => {
				if (params.persist) {
					const visibility = params.readonly ? "readonly" : "active";
					return ctx.projectAgent.activate(
						ctx.projectId,
						params.path,
						visibility,
					);
				}
				// Non-persistent read: promote in latest run only
				const run = await ctx.db.get_latest_run.get({
					project_id: ctx.projectId,
				});
				if (!run) return { status: "ok" };
				const store = ctx.projectAgent.store;
				if (store) {
					await store.promoteByPattern(run.id, params.path, null, 0);
				}
				return { status: "ok" };
			},
			description:
				"Promote entry to full state. With persist, sets file constraint.",
			params: {
				path: "string — file path or glob pattern",
				persist: "boolean? — create file constraint (survives across turns)",
				readonly: "boolean? — with persist, set readonly instead of active",
			},
			requiresInit: true,
		});

		r.register("store", {
			handler: async (params, ctx) => {
				if (params.clear) {
					return ctx.projectAgent.drop(ctx.projectId, params.path);
				}
				if (params.persist) {
					if (params.ignore) {
						return ctx.projectAgent.ignore(ctx.projectId, params.path);
					}
					return ctx.projectAgent.drop(ctx.projectId, params.path);
				}
				// Non-persistent store: demote in latest run only
				const run = await ctx.db.get_latest_run.get({
					project_id: ctx.projectId,
				});
				if (!run) return { status: "ok" };
				const store = ctx.projectAgent.store;
				if (store) {
					await store.demoteByPattern(run.id, params.path, null);
				}
				return { status: "ok" };
			},
			description:
				"Demote entry to stored state. With persist, sets file constraint.",
			params: {
				path: "string — file path or glob pattern",
				persist: "boolean? — create file constraint",
				ignore: "boolean? — with persist, exclude from scan entirely",
				clear: "boolean? — remove existing constraint",
			},
			requiresInit: true,
		});

		r.register("getEntries", {
			handler: async (params, ctx) => {
				const run = await ctx.db.get_latest_run.get({
					project_id: ctx.projectId,
				});
				if (!run) return [];
				const store = ctx.projectAgent.store;
				if (!store) return [];
				const entries = await store.getEntriesByPattern(
					run.id,
					params.pattern || "*",
					params.body || null,
				);
				return entries.map((e) => ({
					path: e.path,
					scheme: e.scheme,
					state: e.state,
					tokens: e.tokens_full,
				}));
			},
			description:
				"Query entries by pattern. Replaces getFiles/fileStatus. Returns [{ path, scheme, state, tokens }].",
			params: {
				pattern: "string? — glob pattern (default: *)",
				body: "string? — filter by body content",
			},
			requiresInit: true,
		});

		// --- Runs ---

		r.register("ask", {
			handler: async (params, ctx) => {
				if (!params.model) throw new Error("model is required");
				return ctx.projectAgent.ask(
					ctx.projectId,
					params.model,
					params.prompt,
					params.run,
					{
						temperature: params.temperature,
						persona: params.persona,
						contextLimit: params.contextLimit,
						noContext: params.noContext,
						fork: params.fork,
					},
				);
			},
			description:
				"Non-mutating query. Model required. Returns { run, status, turn }.",
			longRunning: true,
			params: {
				prompt: "string — user message",
				model: "string — model alias (required)",
				run: "string? — continue existing run",
				temperature: "number? — 0 to 2",
				persona: "string? — agent persona for new run",
				contextLimit: "number? — token limit for new run",
				noContext: "boolean? — skip file map (Lite mode)",
				fork: "boolean? — branch from run history",
			},
			requiresInit: true,
		});

		r.register("act", {
			handler: async (params, ctx) => {
				if (!params.model) throw new Error("model is required");
				return ctx.projectAgent.act(
					ctx.projectId,
					params.model,
					params.prompt,
					params.run,
					{
						temperature: params.temperature,
						persona: params.persona,
						contextLimit: params.contextLimit,
						noContext: params.noContext,
						fork: params.fork,
					},
				);
			},
			description:
				"Mutating directive. Model required. Returns { run, status, turn, proposed? }.",
			longRunning: true,
			params: {
				prompt: "string — user message",
				model: "string — model alias (required)",
				run: "string? — continue existing run",
				temperature: "number? — 0 to 2",
				persona: "string? — agent persona for new run",
				contextLimit: "number? — token limit for new run",
				noContext: "boolean? — skip file map (Lite mode)",
				fork: "boolean? — branch from run history",
			},
			requiresInit: true,
		});

		r.register("run/resolve", {
			handler: async (params, ctx) =>
				ctx.projectAgent.resolve(params.run, params.resolution),
			description: "Resolve a proposed entry. Returns { run, status }.",
			longRunning: true,
			params: {
				run: "string — run alias",
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
				ctx.projectAgent.abortRun(runRow.id);
				await ctx.db.update_run_status.run({
					id: runRow.id,
					status: "aborted",
				});
				return { status: "ok" };
			},
			description: "Abort run. Stops in-flight turns immediately.",
			params: { run: "string — run alias" },
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
				run: "string — current run alias",
				name: "string — new name",
			},
			requiresInit: true,
		});

		r.register("run/inject", {
			handler: async (params, ctx) =>
				ctx.projectAgent.inject(params.run, params.message),
			description:
				"Inject a message into a run. If idle, resumes. If active, queues for next turn.",
			longRunning: true,
			params: {
				run: "string — run alias",
				message: "string — message to inject",
			},
			requiresInit: true,
		});

		r.register("run/config", {
			handler: async (params, ctx) => {
				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow)
					throw new Error(msg("error.run_not_found", { runId: params.run }));
				await ctx.db.update_run_config.run({
					id: runRow.id,
					temperature: params.temperature ?? null,
					persona: params.persona ?? null,
					context_limit: params.contextLimit ?? null,
					model_id: params.model ?? null,
				});
				return { status: "ok" };
			},
			description:
				"Update run configuration (temperature, persona, context_limit, model).",
			params: {
				run: "string — run alias",
				temperature: "number? — 0 to 2",
				persona: "string?",
				contextLimit: "number?",
				model: "string? — model alias",
			},
			requiresInit: true,
		});

		// --- Queries ---

		r.register("getRuns", {
			handler: async (_params, ctx) => {
				const rows = await ctx.db.get_runs_by_project.all({
					project_id: ctx.projectId,
				});
				return rows.map((r) => ({
					run: r.alias,
					status: r.status,
					turn: r.turn,
					summary: r.summary || "",
					created: r.created_at,
				}));
			},
			description: "List all runs for the current project.",
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
					model: run.model_id,
					temperature: run.temperature,
					persona: run.persona,
					context_limit: run.context_limit,
					context: {
						telemetry: {
							prompt_tokens: telemetry.prompt_tokens,
							completion_tokens: telemetry.completion_tokens,
							total_tokens: telemetry.total_tokens,
							cost: telemetry.cost,
						},
						reasoning: reasoning.map((r) => ({
							path: r.path,
							body: r.body,
							turn: r.turn,
						})),
						content: content.map((c) => ({
							path: c.path,
							body: c.body,
							turn: c.turn,
						})),
						history: history.map((h) => {
							const scheme = h.path.split("://")[0];
							return {
								scheme,
								path: h.path,
								status: h.status,
								body: h.body,
								attributes: h.attributes ? JSON.parse(h.attributes) : null,
								turn: h.turn,
							};
						}),
					},
					last_user_prompt: promptRow?.body || "",
					last_summary: summaryRow?.body || "",
				};
			},
			description:
				"Full run detail: config, context (telemetry, reasoning, content, history), last_user_prompt, last_summary.",
			params: { run: "string — run alias" },
			requiresInit: true,
		});

		// --- Notifications ---

		r.registerNotification(
			"run/state",
			"Turn state update. { run, turn, status, summary, history[], unknowns[], proposed[], telemetry }.",
		);
		r.registerNotification(
			"run/progress",
			"Turn status. { run, turn, status: 'thinking'|'processing' }.",
		);
		r.registerNotification("ui/render", "Streaming output. { text, append }.");
		r.registerNotification("ui/notify", "Toast notification. { text, level }.");
	}
}
