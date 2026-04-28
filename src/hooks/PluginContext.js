// Plugin-only registration interface; tool verbs live on RummyContext. PLUGINS.md.
export default class PluginContext {
	#name;
	#hooks;

	constructor(name, hooks) {
		this.#name = name;
		this.#hooks = hooks;
	}

	get name() {
		return this.#name;
	}

	#schemes = [];

	get hooks() {
		return this.#hooks;
	}

	get schemes() {
		return this.#schemes;
	}

	registerScheme({
		name,
		modelVisible = 1,
		category = "logging",
		scope = "run",
		writableBy = ["model", "plugin"],
	} = {}) {
		if (!PluginContext.CATEGORIES.has(category)) {
			throw new Error(
				`Invalid category "${category}". Must be one of: ${[...PluginContext.CATEGORIES].join(", ")}`,
			);
		}
		if (!PluginContext.SCOPES.has(scope)) {
			throw new Error(
				`Invalid scope "${scope}". Must be one of: ${[...PluginContext.SCOPES].join(", ")}`,
			);
		}
		for (const w of writableBy) {
			if (!PluginContext.WRITERS.has(w)) {
				throw new Error(
					`Invalid writer "${w}" in writableBy. Must be one of: ${[...PluginContext.WRITERS].join(", ")}`,
				);
			}
		}
		this.#schemes.push({
			name: name || this.#name,
			model_visible: modelVisible,
			category,
			default_scope: scope,
			writable_by: JSON.stringify(writableBy),
		});
	}

	static CATEGORIES = Object.freeze(
		new Set(["data", "logging", "unknown", "prompt"]),
	);

	static SCOPES = Object.freeze(new Set(["run", "project", "global"]));

	static WRITERS = Object.freeze(
		new Set(["model", "plugin", "client", "system"]),
	);

	ensureTool() {
		this.#hooks.tools.ensureTool(this.#name);
	}

	// Hide from tool lists; handler still dispatches if the model emits the tag.
	markHidden() {
		this.#hooks.tools.markHidden(this.#name);
	}

	// "handler" / "visible" / "summarized" are special; everything else is a hook event name.
	on(event, callback, priority = 10) {
		if (event === "handler") {
			this.#hooks.tools.ensureTool(this.#name);
			this.#hooks.tools.onHandle(this.#name, callback, priority);
			return;
		}
		if (event === "visible" || event === "summarized") {
			this.#hooks.tools.onView(this.#name, callback, event);
			return;
		}
		const hook = this.#resolveEvent(event);
		if (hook) hook.on(callback, priority);
	}

	filter(name, callback, priority = 10) {
		const hook = this.#resolveFilter(name);
		if (hook) hook.addFilter(callback, priority);
	}

	#resolveEvent(name) {
		const parts = name.split(".");
		let node = this.#hooks;
		for (const part of parts) {
			node = node?.[part];
		}
		if (node?.on) return node;
		return null;
	}

	#resolveFilter(name) {
		const parts = name.split(".");
		let node = this.#hooks;
		for (const part of parts) {
			node = node?.[part];
		}
		if (node?.addFilter) return node;
		return null;
	}
}
