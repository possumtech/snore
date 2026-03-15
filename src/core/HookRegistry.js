export default class HookRegistry {
	#events = new Map();
	#filters = new Map();
	#debug = process.env.SNORE_DEBUG === "true";

	static #instance;
	static get instance() {
		if (!HookRegistry.#instance) HookRegistry.#instance = new HookRegistry();
		return HookRegistry.#instance;
	}

	/**
	 * Add an Event Listener (Action)
	 */
	addEvent(tag, callback, priority = 10) {
		this.#register(this.#events, tag, callback, priority);
	}

	/**
	 * Add a Filter (Data Mutator)
	 */
	addFilter(tag, callback, priority = 10) {
		this.#register(this.#filters, tag, callback, priority);
	}

	#register(map, tag, callback, priority) {
		if (!map.has(tag)) map.set(tag, []);
		map.get(tag).push({ callback, priority });
		map.get(tag).sort((a, b) => a.priority - b.priority);
	}

	count(tag) {
		const eventCount = (this.#events.get(tag) || []).length;
		const filterCount = (this.#filters.get(tag) || []).length;
		return eventCount + filterCount;
	}

	/**
	 * Trigger all listeners for an event
	 */
	async emitEvent(tag, ...args) {
		const hooks = this.#events.get(tag) || [];
		if (this.#debug) console.log(`[EVENT] ${tag} (${hooks.length} listeners)`);

		for (const hook of hooks) {
			const start = performance.now();
			await hook.callback(...args);
			if (this.#debug) {
				const duration = (performance.now() - start).toFixed(2);
				console.log(
					`  -> ${hook.callback.name || "anonymous"} completed in ${duration}ms`,
				);
			}
		}
	}

	async applyFilters(tag, value, ...args) {
		const hooks = this.#filters.get(tag) || [];
		if (this.#debug) console.log(`[FILTER] ${tag} (${hooks.length} mutators)`);

		let filteredValue = value;
		for (const hook of hooks) {
			const start = performance.now();
			filteredValue = await hook.callback(filteredValue, ...args);
			if (this.#debug) {
				const duration = (performance.now() - start).toFixed(2);
				console.log(
					`  -> ${hook.callback.name || "anonymous"} returned modified value in ${duration}ms`,
				);
			}
		}
		return filteredValue;
	}

	// Aliases for transition
	addAction(tag, callback, priority) {
		this.addEvent(tag, callback, priority);
	}
	async doAction(tag, ...args) {
		await this.emitEvent(tag, ...args);
	}
}
