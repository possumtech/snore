import msg from "../../agent/messages.js";
import File from "../file/file.js";
import RummyContext from "../../hooks/RummyContext.js";

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

		// --- Primitives (SPEC §0.2) ---
		// The client surface is a thin projection of the plugin API.
		// Six verbs, each takes an object of entry-grammar params.
		// Writer is fixed to "client"; permissions enforced per scheme.

		r.register("set", {
			handler: async (params, ctx) => {
				return await this.#dispatchSet(params, ctx);
			},
			description:
				"Create or update an entry. Wide semantic: write content, change " +
				"fidelity/state, merge attributes, append (streaming), pattern update. " +
				"Writing to run://<alias> starts or cancels a run.",
			params: {
				run: "string — run alias (except for new run:// writes, where the alias is in the path)",
				path: "string — entry path (e.g. known://fact or run://abc)",
				body: "string? — entry body",
				state: "string? — proposed | streaming | resolved | failed | cancelled",
				fidelity: "string? — promoted | demoted | archived",
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
				"Promote an entry (or matching pattern) to visible fidelity.",
			params: {
				run: "string — run alias",
				path: "string — entry path or glob pattern",
				bodyFilter: "string? — narrow pattern matches by body content",
				fidelity: "string? — target fidelity (default: promoted)",
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
					fidelity: params.fidelity,
					writer: "client",
				});
				return { ok: true };
			},
			description: "Copy an entry to a new path.",
			params: {
				run: "string — run alias",
				from: "string — source path",
				to: "string — destination path",
				fidelity: "string? — target fidelity (default: promoted)",
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
					fidelity: params.fidelity,
					writer: "client",
				});
				return { ok: true };
			},
			description: "Rename an entry (copy then remove source).",
			params: {
				run: "string — run alias",
				from: "string — source path",
				to: "string — destination path",
				fidelity: "string? — target fidelity (default: promoted)",
			},
			requiresInit: true,
		});

		r.register("update", {
			handler: async (params, ctx) => {
				const runRow = await this.#resolveRun(params.run, ctx);
				const path = await ctx.projectAgent.entries.update({
					runId: runRow.id,
					body: params.body,
					status: params.status ?? 102,
					attributes: params.attributes ?? {},
					writer: "client",
				});
				return { ok: true, path };
			},
			description:
				"Write an update:// entry carrying a turn's continuation/terminal " +
				"signal. Not general — this is the lifecycle verb.",
			params: {
				run: "string — run alias",
				body: "string — update text",
				status:
					"number? — 102 (continue) | 200/204 (terminal) | 422 (can't answer)",
				attributes: "object? — extra attributes",
			},
			requiresInit: true,
		});

		// Connection handshake. First call a client makes. Establishes
		// the project identity for this connection and announces the
		// server's protocol version. Absorbed what `init` used to do.
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
				const pattern = params.pattern ?? "*";
				const rows = await ctx.projectAgent.entries.getEntriesByPattern(
					runRow.id,
					pattern,
					params.bodyFilter ?? null,
				);
				return rows
					.filter((e) => !params.scheme || e.scheme === params.scheme)
					.filter((e) => !params.state || e.state === params.state)
					.filter((e) => !params.fidelity || e.fidelity === params.fidelity)
					.map((e) => ({
						path: e.path,
						scheme: e.scheme,
						state: e.state,
						outcome: e.outcome,
						fidelity: e.fidelity,
						turn: e.turn,
						tokens: e.tokens,
						attributes:
							typeof e.attributes === "string"
								? JSON.parse(e.attributes)
								: e.attributes,
					}));
			},
			description:
				"List entries matching a pattern. Read-only — no promotion. " +
				"Optional filters: scheme, state, fidelity, bodyFilter.",
			params: {
				run: "string — run alias",
				pattern: "string? — glob pattern (default '*')",
				scheme: "string? — filter by scheme (e.g. 'file')",
				state: "string? — filter by state",
				fidelity: "string? — filter by fidelity",
				bodyFilter: "string? — narrow pattern matches by body content",
			},
			requiresInit: true,
		});

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

		// run:// is the lifecycle surface. A set to a brand-new run://
		// alias starts a run loop; a state transition cancels or resolves.
		if (params.path.startsWith("run://")) {
			return await this.#dispatchRunSet(params, ctx);
		}

		const runRow = await this.#resolveRun(params.run, ctx);

		// State transition on an existing proposed entry → route through
		// AgentLoop.resolve, which applies scheme-specific side effects
		// (patch application for set://, file removal for rm://, stream
		// setup for sh:// / env://, etc.).
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
					return await ctx.projectAgent.resolve(params.run, {
						path: params.path,
						action,
						output: params.body ?? null,
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
			fidelity: params.fidelity,
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

		// Empty alias on a new-run set → synthesize ${model}_${epoch}.
		// Matches AgentLoop.#generateAlias so server- and client-initiated
		// runs share one naming scheme. Clients that want a specific name
		// pass it in the path; anonymous starts get the synthesized one.
		if (!alias) {
			const attrs = params.attributes || {};
			if (!attrs.model) {
				throw new Error(
					"set run://: attributes.model is required when alias is omitted",
				);
			}
			alias = `${attrs.model}_${Date.now()}`;
		}

		const existing = await ctx.db.get_run_by_alias
			.get({ alias })
			.catch(() => null);

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
			const attrs = params.attributes || {};
			if (!attrs.model) {
				throw new Error(
					"set run://: attributes.model is required for a new run",
				);
			}
			const mode = attrs.mode ?? "ask";
			// Fire-and-forget: client watches state via entry notifications.
			ctx.projectAgent
				.run(mode, ctx.projectId, attrs.model, params.body || "", null, alias, {
					temperature: attrs.temperature,
					persona: attrs.persona,
					contextLimit: attrs.contextLimit,
					noRepo: attrs.noRepo,
					noInteraction: attrs.noInteraction,
					noWeb: attrs.noWeb,
					noProposals: attrs.noProposals,
					fork: attrs.fork,
				})
				.catch((err) => {
					console.error(`[RUMMY] run ${alias} crashed: ${err.message}`);
				});
			return { ok: true, alias };
		}

		// Existing run with body-only update (continuation prompt). Inject.
		if (params.body) {
			await ctx.projectAgent.inject(alias, params.body);
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
			fidelity: params.fidelity,
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
	const resultPath = await store.dedup(
		rummy.runId,
		scheme,
		path,
		rummy.sequence,
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
