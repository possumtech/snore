/**
 * PluginContext is the interface a plugin receives at construction time.
 * It carries the plugin's identity and provides registration methods
 * for handlers, views, events, and filters.
 *
 * Startup-scoped: created once per plugin when the service starts.
 * Runtime context (runId, turn) is passed to handlers per-invocation.
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

	/**
	 * Register a named callback for this plugin.
	 * "handler" and "view" register against this plugin's tool scheme.
	 * All other names register as event subscriptions.
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
