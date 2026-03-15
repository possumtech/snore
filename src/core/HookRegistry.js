export default class HookRegistry {
	#actions = new Map();
	#filters = new Map();
	#debug = process.env.SNORE_DEBUG === "true";

	/**
	 * Singleton instance for global access
	 */
	static #instance;
	static get instance() {
		if (!HookRegistry.#instance) HookRegistry.#instance = new HookRegistry();
		return HookRegistry.#instance;
	}

	/**
	 * Add an Action (Event Listener)
	 * @param {string} tag - Hook name
	 * @param {Function} callback - Async function
	 * @param {number} priority - Lower numbers run first (default 10)
	 */
	addAction(tag, callback, priority = 10) {
		this.#register(this.#actions, tag, callback, priority);
	}

	/**
	 * Add a Filter (Data Mutator)
	 * @param {string} tag - Hook name
	 * @param {Function} callback - Async function(value, ...args) returning modified value
	 * @param {number} priority - Lower numbers run first (default 10)
	 */
	addFilter(tag, callback, priority = 10) {
		this.#register(this.#filters, tag, callback, priority);
	}

	#register(map, tag, callback, priority) {
		if (!map.has(tag)) map.set(tag, []);
		map.get(tag).push({ callback, priority });
		map.get(tag).sort((a, b) => a.priority - b.priority);
	}

	/**
	 * Execute all callbacks for an action
	 */
	async doAction(tag, ...args) {
		const hooks = this.#actions.get(tag) || [];
		if (this.#debug)
			console.log(`[HOOK] Action: ${tag} (${hooks.length} listeners)`);

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

	/**
	 * Apply all filters to a value
	 */
	async applyFilters(tag, value, ...args) {
		const hooks = this.#filters.get(tag) || [];
		if (this.#debug)
			console.log(`[HOOK] Filter: ${tag} (${hooks.length} mutators)`);

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
}
