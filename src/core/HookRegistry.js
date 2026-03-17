/**
 * HookRegistry manages a simple, priority-ordered pipeline of processors.
 * It also supports basic event emitters for side-effects.
 */
export default class HookRegistry {
	#processors = [];
	#events = new Map();
	#filters = new Map();
	#debug;

	constructor(debug = false) {
		this.#debug = debug;
	}

	/**
	 * Register a processor for the Turn XML Document.
	 */
	onTurn(callback, priority = 10) {
		this.#processors.push({ callback, priority });
		this.#processors.sort((a, b) => a.priority - b.priority);
	}

	/**
	 * Run all registered Turn processors.
	 */
	async processTurn(rummy) {
		for (const p of this.#processors) {
			const start = performance.now();
			await p.callback(rummy);
			if (this.#debug) {
				const duration = (performance.now() - start).toFixed(2);
				console.log(
					`[PIPELINE] Processor ${p.callback.name || "anonymous"} took ${duration}ms`,
				);
			}
		}
	}

	/**
	 * Standard WordPress-style Filters for non-DOM data.
	 */
	addFilter(tag, callback, priority = 10) {
		if (!this.#filters.has(tag)) this.#filters.set(tag, []);
		this.#filters.get(tag).push({ callback, priority });
		this.#filters.get(tag).sort((a, b) => a.priority - b.priority);
	}

	async applyFilters(tag, value, ...args) {
		const hooks = this.#filters.get(tag) || [];
		let result = value;
		for (const h of hooks) {
			result = await h.callback(result, ...args);
		}
		return result;
	}

	/**
	 * Standard WordPress-style Events for side-effects.
	 */
	addEvent(tag, callback, priority = 10) {
		if (!this.#events.has(tag)) this.#events.set(tag, []);
		this.#events.get(tag).push({ callback, priority });
		this.#events.get(tag).sort((a, b) => a.priority - b.priority);
	}

	async emitEvent(tag, ...args) {
		const hooks = this.#events.get(tag) || [];
		for (const h of hooks) {
			await h.callback(...args);
		}
	}
}
