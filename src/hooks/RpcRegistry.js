export default class RpcRegistry {
	#methods = new Map();
	#notifications = new Map();

	register(
		name,
		{
			handler,
			description = "",
			params = {},
			requiresInit = false,
			longRunning = false,
		},
	) {
		this.#methods.set(
			name,
			Object.freeze({
				handler,
				description,
				params,
				requiresInit,
				longRunning,
			}),
		);
	}

	#toolFallback = null;

	/**
	 * Set a fallback that auto-dispatches any registered tool via RPC.
	 * Checked at request time — tools registered after this call still work.
	 */
	setToolFallback(hooks, buildRunContext, dispatchTool) {
		this.#toolFallback = { hooks, buildRunContext, dispatchTool };
	}

	registerNotification(name, description = "") {
		this.#notifications.set(name, Object.freeze({ description }));
	}

	get(name) {
		const method = this.#methods.get(name);
		if (method) return method;
		return this.#resolveToolFallback(name);
	}

	has(name) {
		return this.#methods.has(name) || !!this.#resolveToolFallback(name);
	}

	#resolveToolFallback(name) {
		if (!this.#toolFallback) return undefined;
		const { hooks, buildRunContext, dispatchTool } = this.#toolFallback;
		if (!hooks.tools.has(name)) return undefined;
		return Object.freeze({
			handler: async (params, ctx) => {
				if (!params.path) throw new Error("path is required");
				if (!params.run) throw new Error("run is required");
				const { rummy } = await buildRunContext(hooks, ctx, params.run);
				await dispatchTool(hooks, rummy, name, params.path, params.body || "", {
					path: params.path,
					to: params.to,
					...params.attributes,
				});
				return { status: "ok" };
			},
			description: `Dispatch ${name} tool.`,
			params: {
				run: "string — run alias",
				path: "string — entry path",
				body: "string? — entry content",
				to: "string? — destination path",
				attributes: "object? — JSON attributes",
			},
			requiresInit: true,
			longRunning: false,
		});
	}

	discover() {
		const methods = {};
		for (const [name, def] of this.#methods) {
			methods[name] = { description: def.description, params: def.params };
		}
		// Include auto-dispatched tools not explicitly registered
		if (this.#toolFallback) {
			for (const name of this.#toolFallback.hooks.tools.names) {
				if (methods[name]) continue;
				const def = this.#resolveToolFallback(name);
				if (def)
					methods[name] = { description: def.description, params: def.params };
			}
		}
		const notifications = {};
		for (const [name, def] of this.#notifications) {
			notifications[name] = { description: def.description };
		}
		return { methods, notifications };
	}
}
