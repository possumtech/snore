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

		r.register("getFiles", {
			handler: async (_params, ctx) =>
				ctx.projectAgent.getFiles(ctx.projectPath),
			description:
				"List project files with fidelity. Returns [{ path, fidelity, size }].",
			requiresInit: true,
		});

		r.register("fileStatus", {
			handler: async (params, ctx) =>
				ctx.projectAgent.fileStatus(ctx.projectId, params.path),
			description:
				"File promotion state. Returns { path, fidelity, client_constraint, has_agent_promotion, has_editor_promotion }.",
			params: { path: "string — relative file path" },
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
			description:
				"Remove client promotion. File reverts to baseline fidelity.",
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
			description:
				"Non-mutating query. Returns { run, status, turn }.",
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
			description:
				"Resolve a finding. Returns { run, status }.",
			longRunning: true,
			params: {
				run: "string — run name",
				resolution:
					"{ category: 'diff'|'command'|'notification', id: number, action: 'accepted'|'rejected'|'modified', output?: string }",
			},
			requiresInit: true,
		});

		r.register("run/abort", {
			handler: async (params, ctx) => {
				const runRow = await ctx.db.get_run_by_alias.get({ alias: params.run });
				if (!runRow) throw new Error(`Run '${params.run}' not found.`);
				await ctx.db.update_run_status.run({
					id: runRow.id,
					status: "aborted",
				});
				return { status: "ok" };
			},
			description: "Abandon run. Unresolved findings discarded.",
			params: { run: "string — run name" },
			requiresInit: true,
		});

		r.register("run/rename", {
			handler: async (params, ctx) => {
				const { run, name } = params;
				if (!name || !/^[a-z_]{1,20}$/.test(name)) {
					throw new Error("Name must match [a-z_]{1,20}.");
				}
				const runRow = await ctx.db.get_run_by_alias.get({ alias: run });
				if (!runRow) throw new Error(`Run '${run}' not found.`);
				try {
					await ctx.db.rename_run.run({
						id: runRow.id,
						old_alias: runRow.alias,
						new_alias: name,
					});
				} catch (err) {
					if (err.message.includes("UNIQUE")) {
						throw new Error(`Name '${name}' is already taken.`);
					}
					throw err;
				}
				return { run: name };
			},
			description: "Rename a run. Must be unique, [a-z_]{1,20}.",
			params: {
				run: "string — current run name",
				name: "string — new name, [a-z_]{1,20}",
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
					created: r.created_at,
				}));
			},
			description: "List all runs for the current session.",
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

		// Notifications
		r.registerNotification(
			"run/step/completed",
			"Turn finished. Payload: { run, turn: { sequence, assistant: { todo[], known[], unknown[], summary, content }, feedback[], usage: { prompt_tokens, completion_tokens, cost } }, files[] }.",
		);
		r.registerNotification(
			"run/progress",
			"Turn status. Payload: { run, turn, status: 'thinking'|'processing'|'retrying' }.",
		);
		r.registerNotification(
			"editor/diff",
			"Proposed edit. Payload: { run, findingId, type: 'edit', file, patch (unified diff) }.",
		);
		r.registerNotification(
			"run/env",
			"Proposed read-only command. Payload: { run, findingId, command }.",
		);
		r.registerNotification(
			"run/run",
			"Proposed shell command. Payload: { run, findingId, command }.",
		);
		r.registerNotification(
			"ui/prompt",
			"Model question. Payload: { run, findingId, question, options[] }.",
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
