import msg from "../../agent/messages.js";
import RummyContext from "../../hooks/RummyContext.js";
import File from "../file/file.js";

const CONSTRAINT_VISIBILITIES = new Set(["active", "readonly", "ignore"]);

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

		// Primitives (SPEC #primitives); writer fixed to "client".

		r.register("set", {
			handler: async (params, ctx) => {
				return await this.#dispatchSet(params, ctx);
			},
			description:
				"Create or update an entry. Wide semantic: write content, change " +
				"visibility/state, merge attributes, append (streaming), pattern update. " +
				"Writing to run://<alias> starts or cancels a run.",
			params: {
				run: "string — run alias (except for new run:// writes, where the alias is in the path)",
				path: "string — entry path (e.g. known://fact or run://abc)",
				body: "string? — entry body",
				state: "string? — proposed | streaming | resolved | failed | cancelled",
				visibility: "string? — visible | summarized | archived",
				outcome: "string? — reason when state ∈ {failed, cancelled}",
				attributes: "object? — JSON attributes",
				append: "boolean? — append body rather than overwrite",
				pattern: "boolean? — treat path as a glob pattern for bulk update",
				bodyFilter: "string? — narrow pattern matches by body content",
			},
			requiresInit: true,
			longRunning: true,
		});

		r.register("get", {
			handler: async (params, ctx) => {
				return await this.#dispatchGet(params, ctx);
			},
			description:
				"Promote an entry (or matching pattern) to visible visibility.",
			params: {
				run: "string — run alias",
				path: "string — entry path or glob pattern",
				bodyFilter: "string? — narrow pattern matches by body content",
				visibility: "string? — target visibility (default: visible)",
			},
			requiresInit: true,
		});

		r.register("rm", {
			handler: async (params, ctx) => {
				return await this.#dispatchRm(params, ctx);
			},
			description: "Remove an entry's view (or matching pattern).",
			params: {
				run: "string — run alias",
				path: "string — entry path or glob pattern",
				bodyFilter: "string? — narrow pattern matches by body content",
			},
			requiresInit: true,
		});

		r.register("cp", {
			handler: async (params, ctx) => {
				const runRow = await this.#resolveRun(params.run, ctx);
				await ctx.projectAgent.entries.cp({
					runId: runRow.id,
					from: params.from,
					to: params.to,
					visibility: params.visibility,
					writer: "client",
				});
				return { ok: true };
			},
			description: "Copy an entry to a new path.",
			params: {
				run: "string — run alias",
				from: "string — source path",
				to: "string — destination path",
				visibility: "string? — target visibility (default: visible)",
			},
			requiresInit: true,
		});

		r.register("mv", {
			handler: async (params, ctx) => {
				const runRow = await this.#resolveRun(params.run, ctx);
				await ctx.projectAgent.entries.mv({
					runId: runRow.id,
					from: params.from,
					to: params.to,
					visibility: params.visibility,
					writer: "client",
				});
				return { ok: true };
			},
			description: "Rename an entry (copy then remove source).",
			params: {
				run: "string — run alias",
				from: "string — source path",
				to: "string — destination path",
				visibility: "string? — target visibility (default: visible)",
			},
			requiresInit: true,
		});

		r.register("update", {
			handler: async (params, ctx) => {
				const runRow = await this.#resolveRun(params.run, ctx);
				const { status = 102, attributes = {} } = params;
				const path = await ctx.projectAgent.entries.update({
					runId: runRow.id,
					body: params.body,
					status,
					attributes,
					writer: "client",
				});
				return { ok: true, path };
			},
			description:
				"Write a status update at log://turn_N/update/<slug> carrying a " +
				"turn's continuation/terminal signal. Not general — this is the " +
				"lifecycle verb.",
			params: {
				run: "string — run alias",
				body: "string — update text",
				status:
					"number? — 102 (continue) | 200/204 (terminal) | 422 (can't answer)",
				attributes: "object? — extra attributes",
			},
			requiresInit: true,
		});

		// Connection handshake; project identity + protocol version.
		r.register("rummy/hello", {
			handler: async (params, ctx) => {
				const { RUMMY_PROTOCOL_VERSION } = await import(
					"../../server/protocol.js"
				);
				if (params.clientVersion) {
					const clientMajor = String(params.clientVersion).split(".")[0];
					const serverMajor = RUMMY_PROTOCOL_VERSION.split(".")[0];
					if (clientMajor !== serverMajor) {
						throw new Error(
							`protocol mismatch: server ${RUMMY_PROTOCOL_VERSION}, client ${params.clientVersion}. Clients must match MAJOR.`,
						);
					}
				}
				if (!params.name) throw new Error("rummy/hello: name is required");
				if (!params.projectRoot) {
					throw new Error("rummy/hello: projectRoot is required");
				}
				const result = await ctx.projectAgent.init(
					params.name,
					params.projectRoot,
					params.configPath,
				);
				ctx.setContext(result.projectId, params.projectRoot);
				return {
					rummyVersion: RUMMY_PROTOCOL_VERSION,
					projectId: result.projectId,
					projectRoot: params.projectRoot,
				};
			},
			description:
				"Connection handshake. First call a client makes. Establishes the " +
				"project identity and returns the server's protocol version. " +
				"Clients must match MAJOR or the call rejects.",
			params: {
				name: "string — project name (unique identifier)",
				projectRoot: "string — absolute path to source code",
				configPath: "string? — path to rummy config directory",
				clientVersion:
					"string? — client's protocol version; server rejects MAJOR mismatch",
			},
		});

		// --- Models ---

		r.register("getModels", {
			handler: async (params, ctx) => {
				const { limit = null, offset = null } = params;
				const rows = await ctx.db.get_models.all({ limit, offset });
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
				const { contextLength = null } = params;
				const row = await ctx.db.upsert_model.get({
					alias: params.alias,
					actual: params.actual,
					context_length: contextLength,
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

		// --- File constraints (project-scoped overlay) ---

		r.register("file/constraint", {
			handler: async (params, ctx) => {
				if (!params.pattern) {
					throw new Error("file/constraint: pattern is required");
				}
				if (!CONSTRAINT_VISIBILITIES.has(params.visibility)) {
					throw new Error(
						`file/constraint: visibility must be one of ${[...CONSTRAINT_VISIBILITIES].join(", ")}`,
					);
				}
				const normalized = await File.setConstraint(
					ctx.db,
					ctx.projectId,
					params.pattern,
					params.visibility,
				);
				return { ok: true, pattern: normalized };
			},
			description:
				"Set a project-level file constraint. Visibility ∈ " +
				"{active, readonly, ignore}. Patterns can be globs. " +
				"Persists across runs; overlays git defaults.",
			params: {
				pattern: "string — file path or glob",
				visibility: "string — active | readonly | ignore",
			},
			requiresInit: true,
		});

		r.register("file/drop", {
			handler: async (params, ctx) => {
				if (!params.pattern) {
					throw new Error("file/drop: pattern is required");
				}
				const normalized = await File.dropConstraint(
					ctx.db,
					ctx.projectId,
					params.pattern,
				);
				return { ok: true, pattern: normalized };
			},
			description: "Remove a project-level file constraint.",
			params: { pattern: "string — file path or glob to drop" },
			requiresInit: true,
		});

		r.register("getConstraints", {
			handler: async (_params, ctx) => {
				const rows = await ctx.db.get_file_constraints.all({
					project_id: ctx.projectId,
				});
				return rows.map((r) => ({
					pattern: r.pattern,
					visibility: r.visibility,
				}));
			},
			description:
				"List project-level file constraints as [{pattern, visibility}].",
			requiresInit: true,
		});

		// --- Queries ---

		r.register("getEntries", {
			handler: async (params, ctx) => {
				const runRow = await this.#resolveRun(params.run, ctx);
				const {
					pattern = "*",
					bodyFilter = null,
					since = null,
					limit = null,
					withBody = false,
				} = params;
				const rows = await ctx.projectAgent.entries.getEntriesByPattern(
					runRow.id,
					pattern,
					bodyFilter,
					{ since, limit },
				);
				return rows
					.filter((e) => !params.scheme || e.scheme === params.scheme)
					.filter((e) => !params.state || e.state === params.state)
					.filter(
						(e) => !params.visibility || e.visibility === params.visibility,
					)
					.map((e) => {
						const row = {
							id: e.id,
							path: e.path,
							scheme: e.scheme,
							state: e.state,
							outcome: e.outcome,
							visibility: e.visibility,
							turn: e.turn,
							tokens: e.tokens,
							attributes:
								typeof e.attributes === "string"
									? JSON.parse(e.attributes)
									: e.attributes,
						};
						if (withBody) row.body = e.body;
						return row;
					});
			},
			description:
				"List entries matching a pattern. Read-only — no promotion. " +
				"Optional filters: scheme, state, visibility, bodyFilter. " +
				"Pass `withBody: true` to include `body` on each row (omitted by default to keep pulse-reconcile traffic lean). " +
				"For incremental sync after a `run/changed` pulse, pass `since` (last seen entry id); " +
				"use `limit` to chunk catch-up.",
			params: {
				run: "string — run alias",
				pattern: "string? — glob pattern (default '*')",
				scheme: "string? — filter by scheme (e.g. 'file')",
				state: "string? — filter by state",
				visibility: "string? — filter by visibility",
				bodyFilter:
					"string? — filter rows by content of body (substring/glob; NOT for body inclusion — see withBody)",
				withBody:
					"boolean? — include `body` field on each returned row (default false)",
				since: "number? — only entries with id > since (insertion-ordered)",
				limit: "number? — cap result count",
			},
			requiresInit: true,
		});

		r.register("getRuns", {
			handler: async (params, ctx) => {
				const { limit = null, offset = null } = params;
				const rows = await ctx.db.get_runs_by_project.all({
					project_id: ctx.projectId,
					limit,
					offset,
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

		r.registerNotification(
			"run/changed",
			"Pulse: an entry under this run changed. Query with `getEntries(run, { pattern, since })` to reconcile.",
		);
		r.registerNotification(
			"stream/cancelled",
			"Server-initiated stream cancellation.",
		);
		r.registerNotification("ui/render", "Streaming output.");
		r.registerNotification("ui/notify", "Toast notification.");

		// Any registered tool is callable via RPC; resolved at request time.
		r.setToolFallback(hooks, buildRunContext, dispatchTool);
	}

	// --- Primitive dispatch helpers ---

	async #resolveRun(runAlias, ctx) {
		if (!runAlias) throw new Error("run is required");
		const runRow = await ctx.db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));
		return runRow;
	}

	async #dispatchSet(params, ctx) {
		if (!params.path) throw new Error("set: path is required");

		// run:// = lifecycle surface (start run, cancel, resolve).
		if (params.path.startsWith("run://")) {
			return await this.#dispatchRunSet(params, ctx);
		}

		const runRow = await this.#resolveRun(params.run, ctx);

		// State transitions on proposed entries → AgentLoop.resolve for scheme-specific effects.
		if (params.state && !params.append && !params.pattern) {
			const current = await ctx.projectAgent.entries.getState(
				runRow.id,
				params.path,
			);
			if (current?.state === "proposed") {
				const action =
					params.state === "resolved"
						? "accept"
						: params.state === "failed"
							? "error"
							: params.state === "cancelled"
								? "reject"
								: null;
				if (action) {
					const { body = null } = params;
					return await ctx.projectAgent.resolve(params.run, {
						path: params.path,
						action,
						output: body,
					});
				}
			}
		}

		await ctx.projectAgent.entries.set({
			runId: runRow.id,
			projectId: ctx.projectId,
			path: params.path,
			body: params.body,
			state: params.state,
			visibility: params.visibility,
			outcome: params.outcome,
			attributes: params.attributes,
			append: params.append,
			pattern: params.pattern,
			bodyFilter: params.bodyFilter,
			writer: "client",
		});
		return { ok: true };
	}

	async #dispatchRunSet(params, ctx) {
		let alias = params.path.slice("run://".length);

		// Empty alias → ${model}_${epoch}; mirrors AgentLoop.#generateAlias.
		if (!alias) {
			const { attributes: attrs = {} } = params;
			if (!attrs.model) {
				throw new Error(
					"set run://: attributes.model is required when alias is omitted",
				);
			}
			alias = `${attrs.model}_${Date.now()}`;
		}

		const existing = await ctx.db.get_run_by_alias.get({ alias });

		const runPath = `run://${alias}`;

		// State transition on an existing run.
		if (existing && params.state) {
			if (params.state === "cancelled") {
				ctx.projectAgent.abortRun(existing.id);
			}
			await ctx.projectAgent.entries.set({
				runId: existing.id,
				path: runPath,
				state: params.state,
				outcome: params.outcome,
				writer: "client",
			});
			return { ok: true, alias };
		}

		// New run — kick off the loop. AgentLoop handles row + entry creation.
		if (!existing) {
			const { attributes: attrs = {} } = params;
			if (!attrs.model) {
				throw new Error(
					"set run://: attributes.model is required for a new run",
				);
			}
			const { mode } = attrs;
			if (mode !== "ask" && mode !== "act") {
				throw new Error(
					`set run://: attributes.mode is required and must be "ask" or "act" (got ${JSON.stringify(mode)})`,
				);
			}
			const options = {
				temperature: attrs.temperature,
				persona: attrs.persona,
				contextLimit: attrs.contextLimit,
				noRepo: attrs.noRepo,
				noInteraction: attrs.noInteraction,
				noWeb: attrs.noWeb,
				noProposals: attrs.noProposals,
				yolo: attrs.yolo,
				fork: attrs.fork,
			};
			const { body = "" } = params;
			// Fire-and-forget; client watches state via entry notifications.
			const kickoff =
				mode === "act"
					? ctx.projectAgent.act(
							ctx.projectId,
							attrs.model,
							body,
							alias,
							options,
						)
					: ctx.projectAgent.ask(
							ctx.projectId,
							attrs.model,
							body,
							alias,
							options,
						);
			kickoff.catch((err) => {
				console.error(`[RUMMY] run ${alias} crashed: ${err.message}`);
			});
			return { ok: true, alias };
		}

		// fork=true → new child run with parent_run_id; inject() would only add a prompt to parent.
		const attrs = params.attributes ? params.attributes : {};
		if (attrs.fork === true) {
			const { mode } = attrs;
			if (mode !== "ask" && mode !== "act") {
				throw new Error(
					`set run://: attributes.mode is required on fork and must be "ask" or "act" (got ${JSON.stringify(mode)})`,
				);
			}
			const model = attrs.model ? attrs.model : existing.model;
			const prompt = params.body ? params.body : "";
			const childInfo = await ctx.projectAgent.ensureRun(
				ctx.projectId,
				model,
				alias,
				prompt,
				{
					fork: true,
					temperature: attrs.temperature,
					persona: attrs.persona,
					contextLimit: attrs.contextLimit,
				},
			);
			const options = {
				temperature: attrs.temperature,
				persona: attrs.persona,
				contextLimit: attrs.contextLimit,
				noRepo: attrs.noRepo,
				noInteraction: attrs.noInteraction,
				noWeb: attrs.noWeb,
				noProposals: attrs.noProposals,
				yolo: attrs.yolo,
				// fork already applied — pass false to reuse the child row.
				fork: false,
			};
			const kickoff =
				mode === "act"
					? ctx.projectAgent.act(
							ctx.projectId,
							model,
							prompt,
							childInfo.alias,
							options,
						)
					: ctx.projectAgent.ask(
							ctx.projectId,
							model,
							prompt,
							childInfo.alias,
							options,
						);
			kickoff.catch((err) => {
				console.error(
					`[RUMMY] fork ${childInfo.alias} crashed: ${err.message}`,
				);
			});
			return { ok: true, alias: childInfo.alias };
		}

		// Existing run with body-only update (continuation prompt). Inject.
		if (params.body) {
			const { mode } = attrs;
			if (mode !== "ask" && mode !== "act") {
				throw new Error(
					`set run://: attributes.mode is required on inject and must be "ask" or "act" (got ${JSON.stringify(mode)})`,
				);
			}
			const options = {
				temperature: attrs.temperature,
				noRepo: attrs.noRepo,
				noInteraction: attrs.noInteraction,
				noWeb: attrs.noWeb,
				noProposals: attrs.noProposals,
				yolo: attrs.yolo,
			};
			await ctx.projectAgent.inject(alias, params.body, mode, options);
			return { ok: true, alias };
		}

		return { ok: true, alias };
	}

	async #dispatchGet(params, ctx) {
		const runRow = await this.#resolveRun(params.run, ctx);
		await ctx.projectAgent.entries.get({
			runId: runRow.id,
			turn: await ctx.projectAgent.entries.nextTurn(runRow.id),
			path: params.path,
			bodyFilter: params.bodyFilter,
			visibility: params.visibility,
		});
		return { ok: true };
	}

	async #dispatchRm(params, ctx) {
		const runRow = await this.#resolveRun(params.run, ctx);
		await ctx.projectAgent.entries.rm({
			runId: runRow.id,
			path: params.path,
			bodyFilter: params.bodyFilter,
		});
		return { ok: true };
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
	const resultPath = await store.logPath(
		rummy.runId,
		rummy.sequence,
		scheme,
		path,
	);

	await store.set({
		runId: rummy.runId,
		turn: rummy.sequence,
		path: resultPath,
		body,
		state: "resolved",
		attributes: attributes,
		loopId: rummy.loopId,
	});

	const entry = {
		scheme,
		path: resultPath,
		body: body,
		attributes: attributes,
		state: "resolved",
		resultPath,
	};

	await hooks.tools.dispatch(scheme, entry, rummy);
	await hooks.entry.created.emit(entry);

	return entry;
}
