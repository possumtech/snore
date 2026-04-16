import msg from "../../agent/messages.js";
import RummyContext from "../../hooks/RummyContext.js";
import File from "../file/file.js";

export default class Rpc {
	#core;

	constructor(core) {
		this.#core = core;
		const hooks = core.hooks;
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
			description: "Initialize project. Returns { projectId }.",
			params: {
				name: "string — project name (unique identifier)",
				projectRoot: "string — absolute path to source code",
				configPath: "string? — path to rummy config directory",
			},
		});

		// --- Models ---

		r.register("getModels", {
			handler: async (params, ctx) => {
				const rows = await ctx.db.get_models.all({
					limit: params.limit ?? null,
					offset: params.offset ?? null,
				});
				return rows.map((m) => ({
					alias: m.alias,
					actual: m.actual,
					context_length: m.context_length,
				}));
			},
			description: "List available models.",
			params: {
				limit: "number? — max results",
				offset: "number? — skip first N results",
			},
		});

		r.register("addModel", {
			handler: async (params, ctx) => {
				const row = await ctx.db.upsert_model.get({
					alias: params.alias,
					actual: params.actual,
					context_length: params.contextLength ?? null,
				});
				return { id: row.id, alias: params.alias };
			},
			description: "Add or update a model. Returns { id, alias }.",
			params: {
				alias: "string — short name for the model",
				actual: "string — provider/model identifier",
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

		// --- Entry operations (same dispatch as model) ---

		// Override: get has persist flag for file constraint management
		r.register("get", {
			handler: async (params, ctx) => {
				if (!params.path) throw new Error("path is required");

				if (params.persist) {
					const visibility = params.readonly ? "readonly" : "active";
					await File.setConstraint(
						ctx.db,
						ctx.projectId,
						params.path,
						visibility,
					);
				}

				if (!params.run) throw new Error("run is required");
				const { rummy } = await buildRunContext(hooks, ctx, params.run);
				await dispatchTool(hooks, rummy, "get", params.path, "", {
					path: params.path,
				});
				return { status: "ok" };
			},
			description: "Promote entry fidelity.",
			params: {
				path: "string — file path or glob pattern",
				run: "string — run alias",
				persist: "boolean? — also create file constraint",
				readonly: "boolean? — with persist, set readonly instead of active",
			},
			requiresInit: true,
		});

		// store is not a tool — it manages file constraints
		r.register("store", {
			handler: async (params, ctx) => {
				if (!params.path) throw new Error("path is required");

				if (params.clear) {
					await File.dropConstraint(ctx.db, ctx.projectId, params.path);
					return { status: "ok" };
				}
				if (params.persist) {
					const visibility = params.ignore ? "ignore" : "active";
					await File.setConstraint(
						ctx.db,
						ctx.projectId,
						params.path,
						visibility,
					);
				}

				if (!params.run) throw new Error("run is required");
				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow) throw new Error(`Run not found: ${params.run}`);
				const store = ctx.projectAgent.entries;
				await store.demoteByPattern(runRow.id, params.path, null);
				return { status: "ok" };
			},
			description: "Demote entry to stored state.",
			params: {
				path: "string — file path or glob pattern",
				run: "string? — run alias (required without persist)",
				persist: "boolean? — also create file constraint",
				ignore: "boolean? — with persist, exclude from scan",
				clear: "boolean? — remove existing constraint",
			},
			requiresInit: true,
		});

		r.register("getEntries", {
			handler: async (params, ctx) => {
				let run;
				if (params.run) {
					run = await ctx.db.get_run_by_alias.get({ alias: params.run });
				} else {
					run = await ctx.db.get_latest_run.get({ project_id: ctx.projectId });
				}
				if (!run) return [];
				const entries = await ctx.projectAgent.entries.getEntriesByPattern(
					run.id,
					params.pattern ?? "*",
					params.body ?? null,
					{ limit: params.limit ?? null, offset: params.offset ?? null },
				);
				return entries.map((e) => ({
					path: e.path,
					scheme: e.scheme,
					status: e.status,
					fidelity: e.fidelity,
					tokens: e.tokens,
				}));
			},
			description: "Query entries by pattern.",
			params: {
				pattern: "string? — glob pattern (default: *)",
				body: "string? — filter by body content",
				run: "string? — run alias (default: latest run)",
				limit: "number? — max results",
				offset: "number? — skip first N results",
			},
			requiresInit: true,
		});

		// --- Runs ---

		r.register("startRun", {
			handler: async (params, ctx) => {
				if (!params.model) throw new Error("model is required");
				const alias = `${params.model}_${Date.now()}`;
				const runRow = await ctx.db.create_run.get({
					project_id: ctx.projectId,
					parent_run_id: null,
					model: params.model ?? null,
					alias,
					temperature: params.temperature ?? null,
					persona: params.persona ?? null,
					context_limit: params.contextLimit ?? null,
				});
				return { run: alias, id: runRow.id };
			},
			description: "Pre-create a run. Returns { run, id }.",
			params: {
				model: "string — model alias (required)",
				temperature: "number? — 0 to 2",
				persona: "string?",
				contextLimit: "number?",
			},
			requiresInit: true,
		});

		r.register("ask", {
			handler: async (params, ctx) => {
				if (!params.model) throw new Error("model is required");
				return ctx.projectAgent.ask(
					ctx.projectId,
					params.model,
					params.prompt,
					params.run,
					{
						temperature: params.temperature ?? null,
						persona: params.persona ?? null,
						contextLimit: params.contextLimit,
						noRepo: params.noRepo,
						noInteraction: params.noInteraction,
						noProposals: params.noProposals,
						noWeb: params.noWeb,
						fork: params.fork,
					},
				);
			},
			description: "Non-mutating query. Model required.",
			longRunning: true,
			params: {
				prompt: "string — user message",
				model: "string — model alias (required)",
				run: "string? — continue existing run",
				temperature: "number?",
				persona: "string?",
				contextLimit: "number?",
				noRepo: "boolean?",
				noInteraction: "boolean? — disable ask_user tool",
				noWeb: "boolean? — disable search and URL fetch",
				fork: "boolean?",
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
						temperature: params.temperature ?? null,
						persona: params.persona ?? null,
						contextLimit: params.contextLimit,
						noRepo: params.noRepo,
						noInteraction: params.noInteraction,
						noProposals: params.noProposals,
						noWeb: params.noWeb,
						fork: params.fork,
					},
				);
			},
			description: "Mutating directive. Model required.",
			longRunning: true,
			params: {
				prompt: "string — user message",
				model: "string — model alias (required)",
				run: "string? — continue existing run",
				temperature: "number?",
				persona: "string?",
				contextLimit: "number?",
				noRepo: "boolean?",
				noInteraction: "boolean? — disable ask_user tool",
				noWeb: "boolean? — disable search and URL fetch",
				fork: "boolean?",
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
				resolution: "{ path, action: 'accept'|'reject', output? }",
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
					status: 499,
				});
				return { status: "ok" };
			},
			description: "Abort run.",
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
					if (err.message.includes("UNIQUE"))
						throw new Error(msg("error.run_name_taken", { name }));
					throw err;
				}
				return { run: name };
			},
			description: "Rename a run.",
			params: {
				run: "string — current run alias",
				name: "string — new name",
			},
			requiresInit: true,
		});

		r.register("run/inject", {
			handler: async (params, ctx) =>
				ctx.projectAgent.inject(params.run, params.message),
			description: "Inject a message into a run.",
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
					model: params.model ?? null,
				});
				return { status: "ok" };
			},
			description: "Update run configuration.",
			params: {
				run: "string — run alias",
				temperature: "number?",
				persona: "string?",
				contextLimit: "number?",
				model: "string?",
			},
			requiresInit: true,
		});

		// --- Queries ---

		r.register("getRuns", {
			handler: async (params, ctx) => {
				const rows = await ctx.db.get_runs_by_project.all({
					project_id: ctx.projectId,
					limit: params.limit ?? null,
					offset: params.offset ?? null,
				});
				return rows.map((row) => ({
					run: row.alias,
					status: row.status,
					turn: row.turn,
					summary: row.summary,
					created: row.created_at,
				}));
			},
			description: "List runs for the current project.",
			params: {
				limit: "number?",
				offset: "number?",
			},
			requiresInit: true,
		});

		r.register("getRun", {
			handler: async (params, ctx) => {
				const run = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!run)
					throw new Error(msg("error.run_not_found", { runId: params.run }));

				const [telemetry, reasoning, content, history, promptRow, summaryRow] =
					await Promise.all([
						ctx.db.get_run_usage.get({ run_id: run.id }),
						ctx.db.get_reasoning.all({ run_id: run.id }),
						ctx.db.get_content.all({ run_id: run.id }),
						ctx.db.get_results.all({ run_id: run.id }),
						ctx.db.get_latest_user_prompt.get({ run_id: run.id }),
						ctx.db.get_latest_summary.get({ run_id: run.id }),
					]);

				return {
					run: run.alias,
					turn: run.next_turn - 1,
					status: run.status,
					model: run.model,
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
						history: history.map((h) => ({
							tool: h.tool,
							path: h.path,
							status: h.status,
							body: h.body,
							attributes: h.attributes ? JSON.parse(h.attributes) : null,
							turn: h.turn,
						})),
					},
					last_user_prompt: promptRow?.body,
					last_summary: summaryRow?.body,
				};
			},
			description: "Full run detail.",
			params: { run: "string — run alias" },
			requiresInit: true,
		});

		// --- Notifications ---

		r.registerNotification("run/state", "Turn state update.");
		r.registerNotification("run/progress", "Turn status.");
		r.registerNotification("run/proposal", "Proposal awaiting resolution.");
		r.registerNotification(
			"stream/cancelled",
			"Server-initiated stream cancellation.",
		);
		r.registerNotification("ui/render", "Streaming output.");
		r.registerNotification("ui/notify", "Toast notification.");

		// Auto-dispatch: any registered tool is callable via RPC.
		// Checked at request time — no timing dependency on plugin load order.
		r.setToolFallback(hooks, buildRunContext, dispatchTool);
	}
}

async function buildRunContext(hooks, ctx, runAlias) {
	const runRow = await ctx.db.get_run_by_alias.get({ alias: runAlias });
	if (!runRow) throw new Error(msg("error.run_not_found", { runId: runAlias }));
	const project = await ctx.db.get_project_by_id.get({ id: runRow.project_id });
	return {
		runRow,
		rummy: new RummyContext(
			{ tag: "rpc", attrs: {}, content: null, children: [] },
			{
				hooks,
				db: ctx.db,
				store: ctx.projectAgent.entries,
				project,
				type: null,
				sequence: runRow.next_turn,
				runId: runRow.id,
				turnId: null,
				noRepo: false,
				contextSize: null,
				systemPrompt: "",
				loopPrompt: "",
			},
		),
	};
}

async function dispatchTool(hooks, rummy, scheme, path, body, attributes) {
	const store = rummy.entries;
	const resultPath = await store.dedup(
		rummy.runId,
		scheme,
		path,
		rummy.sequence,
	);

	await store.upsert(rummy.runId, rummy.sequence, resultPath, body, 200, {
		attributes: attributes,
		loopId: rummy.loopId,
	});

	const entry = {
		scheme,
		path: resultPath,
		body: body,
		attributes: attributes,
		status: 200,
		resultPath,
	};

	await hooks.tools.dispatch(scheme, entry, rummy);
	await hooks.entry.created.emit(entry);

	return entry;
}
