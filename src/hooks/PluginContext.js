/**
 * PluginContext is the plugin-only interface to the rummy system.
 * Available as `rummy.core` on the per-turn RummyContext, and as the
 * direct object passed to plugin constructors at startup.
 *
 * Carries plugin identity, hook registration, and infrastructure access.
 * The unified API (tool verbs, queries) lives on RummyContext.
 * This is the tier boundary: clients can't reach core.
 */
export default class PluginContext {
	#name;
	#hooks;
	#db = null;
	#store = null;

	constructor(name, hooks) {
		this.#name = name;
		this.#hooks = hooks;
	}

	get name() {
		return this.#name;
	}

	get db() {
		return this.#db;
	}

	set db(value) {
		this.#db = value;
	}

	get entries() {
		return this.#store;
	}

	set entries(value) {
		this.#store = value;
	}

	get hooks() {
		return this.#hooks;
	}

	/**
	 * Register a named callback for this plugin.
	 * "handler" registers the tool handler.
	 * "full"/"summary" register fidelity projections.
	 * "docs" sets tool documentation.
	 * Everything else resolves to a hook event.
	 */
	on(event, callback, priority = 10) {
		if (event === "handler") {
			this.#hooks.tools.ensureTool(this.#name);
			this.#hooks.tools.onHandle(this.#name, callback, priority);
			return;
		}
		if (event === "full" || event === "summary") {
			this.#hooks.tools.ensureTool(this.#name);
			this.#hooks.tools.onProject(this.#name, callback, event);
			return;
		}
		if (event === "docs") {
			this.#hooks.tools.setDocs(this.#name, callback);
			return;
		}
		const hook = this.#resolveEvent(event);
		if (hook) hook.on(callback, priority);
	}

	/**
	 * Register a filter callback.
	 */
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
