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
			handler: async (params, ctx) =>
				ctx.projectAgent.startRun(ctx.sessionId, params),
			description: "Pre-create a run. Returns runId.",
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
					params.runId,
					{
						temperature: params.temperature,
						noContext: params.noContext,
						fork: params.fork,
					},
				);
			},
			description:
				"Non-mutating query. Model responds with JSON: { todo, known[], unknown[], summary }. Returns { runId, status, turn }.",
			longRunning: true,
			params: {
				prompt: "string — user message",
				model: "string — optional override",
				runId: "string — continue existing run",
				noContext: "boolean — skip file map (Lite mode)",
				fork: "boolean — branch from runId history",
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
					params.runId,
					{
						temperature: params.temperature,
						noContext: params.noContext,
						fork: params.fork,
					},
				);
			},
			description:
				"Mutating directive. Model responds with JSON: { todo, known[], unknown[], summary, edits[] }. Returns { runId, status, turn, proposed? }.",
			longRunning: true,
			params: {
				prompt: "string — user message",
				model: "string — optional override",
				runId: "string — continue existing run",
				noContext: "boolean — skip file map (Lite mode)",
				fork: "boolean — branch from runId history",
			},
			requiresInit: true,
		});

		r.register("run/resolve", {
			handler: async (params, ctx) =>
				ctx.projectAgent.resolve(params.runId, params.resolution),
			description:
				"Resolve a finding. Returns { runId, status } — 'proposed' if more remain, 'resolved' if rejected, 'completed' if done, or auto-resumes.",
			longRunning: true,
			params: {
				runId: "string",
				resolution:
					"{ category: 'diff'|'command'|'notification', id: number, action: 'accepted'|'rejected'|'modified', output?: string }",
			},
			requiresInit: true,
		});

		r.register("run/abort", {
			handler: async (params, ctx) => {
				await ctx.db.update_run_status.run({
					id: params.runId,
					status: "aborted",
				});
				return { status: "ok" };
			},
			description: "Abandon run. Unresolved findings discarded.",
			params: { runId: "string" },
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
			"Turn finished. Payload: { runId, turn: { sequence, assistant: { todo[], known[], unknown[], summary, content }, feedback[], usage: { prompt_tokens, completion_tokens, cost } }, files[] }.",
		);
		r.registerNotification(
			"run/progress",
			"Turn status. Payload: { runId, turn, status: 'thinking'|'processing'|'retrying' }.",
		);
		r.registerNotification(
			"editor/diff",
			"Proposed edit. Payload: { runId, findingId, type: 'edit', file, patch (unified diff) }.",
		);
		r.registerNotification(
			"run/env",
			"Proposed read-only command. Payload: { runId, findingId, command }.",
		);
		r.registerNotification(
			"run/run",
			"Proposed shell command. Payload: { runId, findingId, command }.",
		);
		r.registerNotification(
			"ui/prompt",
			"Model question. Payload: { runId, findingId, question, options[] }.",
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
