export default class ToolRegistry {
	#tools = new Map();
	#handlers = new Map();
	#projections = new Map();

	register(name, definition) {
		if (this.#tools.has(name))
			throw new Error(`Tool '${name}' already registered.`);
		const { handler, project, ...rest } = definition;
		this.#tools.set(name, Object.freeze(rest));
		if (handler) this.onHandle(name, handler);
		if (project) this.#projections.set(name, project);
	}

	get(name) {
		return this.#tools.get(name);
	}

	has(name) {
		return this.#tools.has(name);
	}

	/**
	 * Register a handler for a scheme. Multiple handlers per scheme,
	 * executed in priority order (lower = first). Any plugin can hook
	 * any scheme — core tools and third-party use the same interface.
	 */
	onHandle(scheme, handler, priority = 10) {
		if (!this.#handlers.has(scheme)) this.#handlers.set(scheme, []);
		const list = this.#handlers.get(scheme);
		list.push({ handler, priority });
		list.sort((a, b) => a.priority - b.priority);
	}

	/**
	 * Register a projection function for a scheme. The projection
	 * transforms the entry's body/attributes into what the model sees.
	 * Called during materialization. No projection = crash.
	 */
	onProject(scheme, fn) {
		this.#projections.set(scheme, fn);
	}

	/**
	 * Project an entry for model view. Returns the body the model sees.
	 * Throws if no projection is registered for the scheme.
	 */
	project(scheme, entry) {
		const fn = this.#projections.get(scheme);
		if (!fn) {
			throw new Error(
				`No projection registered for scheme '${scheme}'. ` +
					`Every tool must define how its entries appear in the model view.`,
			);
		}
		return fn(entry);
	}

	/**
	 * Check if a projection is registered for a scheme.
	 */
	hasProjection(scheme) {
		return this.#projections.has(scheme);
	}

	/**
	 * Run all handlers for a scheme in priority order.
	 * Each handler receives (entry, rummy). If a handler returns false,
	 * the chain stops (entry was fully handled).
	 */
	async dispatch(scheme, entry, rummy) {
		const list = this.#handlers.get(scheme);
		if (!list) return;
		for (const { handler } of list) {
			const result = await handler(entry, rummy);
			if (result === false) break;
		}
	}

	/**
	 * Materialize tool:// entries into the store for a run.
	 * Called once per run (idempotent).
	 */
	async materialize(store, runId, turn) {
		for (const [name, def] of this.#tools) {
			const path = `tool://${name}`;
			const existing = await store.getBody(runId, path);
			if (existing !== null) continue;

			await store.upsert(runId, turn, path, def.docs || "", "full", {
				attributes: {
					modes: [...(def.modes || [])],
					category: def.category || null,
				},
			});
		}
	}

	get actTools() {
		return new Set(
			[...this.#tools.entries()]
				.filter(([, def]) => def.category === "act")
				.map(([name]) => name),
		);
	}

	get names() {
		return [...this.#tools.keys()];
	}

	namesForMode(mode) {
		return [...this.#tools.entries()]
			.filter(([, def]) => def.modes.has(mode))
			.map(([name]) => name);
	}

	entries() {
		return this.#tools.entries();
	}
}
