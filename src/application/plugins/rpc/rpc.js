export default class CoreRpcPlugin {
	static register(hooks) {
		const r = hooks.rpc.registry;

		r.register("ping", {
			handler: async () => ({}),
			description: "Check server liveness",
		});

		r.register("discover", {
			handler: async (_params, ctx) => ctx.rpcRegistry.discover(),
			description: "Returns full method & notification catalog",
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
			description: "Initialize a project session",
			params: {
				projectPath: "Absolute path to project",
				projectName: "Display name",
				clientId: "Unique client identifier",
				projectBufferFiles: "Optional array of open files in IDE",
			},
		});

		r.register("getModels", {
			handler: async (_params, ctx) => ctx.modelAgent.getModels(),
			description: "Get available local and aliased models",
		});

		r.register("getFiles", {
			handler: async (_params, ctx) =>
				ctx.projectAgent.getFiles(ctx.projectPath),
			description: "List all files in the current project",
			requiresInit: true,
		});

		r.register("fileStatus", {
			handler: async (params, ctx) =>
				ctx.projectAgent.fileStatus(ctx.projectId, params.path),
			description: "Get detailed status for a single file",
			params: { path: "Relative file path" },
			requiresInit: true,
		});

		r.register("activate", {
			handler: async (params, ctx) =>
				ctx.projectAgent.activate(ctx.projectId, params.pattern),
			description: "Make files matching a glob pattern fully active",
			params: { pattern: "Glob pattern" },
			requiresInit: true,
		});

		r.register("readOnly", {
			handler: async (params, ctx) =>
				ctx.projectAgent.readOnly(ctx.projectId, params.pattern),
			description: "Make files matching a glob pattern read-only",
			params: { pattern: "Glob pattern" },
			requiresInit: true,
		});

		r.register("ignore", {
			handler: async (params, ctx) =>
				ctx.projectAgent.ignore(ctx.projectId, params.pattern),
			description: "Hide files matching a glob pattern from the model",
			params: { pattern: "Glob pattern" },
			requiresInit: true,
		});

		r.register("drop", {
			handler: async (params, ctx) =>
				ctx.projectAgent.drop(ctx.projectId, params.pattern),
			description: "Demote files matching a glob pattern to mappable",
			params: { pattern: "Glob pattern" },
			requiresInit: true,
		});

		r.register("startRun", {
			handler: async (params, ctx) =>
				ctx.projectAgent.startRun(ctx.sessionId, params),
			description: "Pre-create a run with config. Returns runId.",
			params: { model: "Optional override", projectBufferFiles: "Open files" },
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
			description: "Send a non-mutating query to the agent",
			params: {
				prompt: "User message",
				model: "Optional override",
				runId: "Optional run to continue",
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
			description: "Send a mutating directive to the agent (can propose edits)",
			params: {
				prompt: "User message",
				model: "Optional override",
				runId: "Optional run to continue",
			},
			requiresInit: true,
		});

		r.register("run/resolve", {
			handler: async (params, ctx) =>
				ctx.projectAgent.resolve(params.runId, params.resolution),
			description: "Resolve a single finding (accept/reject)",
			params: { runId: "Run ID", resolution: "{ category, id, action }" },
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
			description: "Abandon run. Discard unresolved findings.",
			params: { runId: "Run ID" },
			requiresInit: true,
		});

		r.register("systemPrompt", {
			handler: async (params, ctx) => {
				await ctx.projectAgent.setSystemPrompt(ctx.sessionId, params.text);
				return { status: "ok" };
			},
			description: "Set the base system prompt override",
			params: { text: "Text content" },
			requiresInit: true,
		});

		r.register("persona", {
			handler: async (params, ctx) => {
				await ctx.projectAgent.setPersona(ctx.sessionId, params.text);
				return { status: "ok" };
			},
			description: "Set the agent persona",
			params: { text: "Text content" },
			requiresInit: true,
		});

		r.register("skill/add", {
			handler: async (params, ctx) => {
				await ctx.projectAgent.addSkill(ctx.sessionId, params.name);
				return { status: "ok" };
			},
			description: "Enable a skill for this session",
			params: { name: "Skill ID" },
			requiresInit: true,
		});

		r.register("skill/remove", {
			handler: async (params, ctx) => {
				await ctx.projectAgent.removeSkill(ctx.sessionId, params.name);
				return { status: "ok" };
			},
			description: "Disable a session skill",
			params: { name: "Skill ID" },
			requiresInit: true,
		});

		// Notification metadata (for discover)
		r.registerNotification(
			"run/step/completed",
			"A turn finished. Contains structured turn object.",
		);
		r.registerNotification(
			"run/progress",
			"Agent task status and intermediate updates.",
		);
		r.registerNotification(
			"ui/render",
			"Streaming output fragments for display.",
		);
		r.registerNotification("ui/notify", "Toast/status notifications.");
		r.registerNotification("ui/prompt", "Model is asking the user a question.");
		r.registerNotification("run/env", "Proposed environment query. Read-only.");
		r.registerNotification(
			"run/run",
			"Proposed shell command. May have side effects.",
		);
		r.registerNotification("editor/diff", "Proposed file modifications.");
	}
}
