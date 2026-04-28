// Priority-ordered processors + filters + events.
export default class HookRegistry {
	#processors = [];
	#events = new Map();
	#filters = new Map();
	#debug;

	constructor(debug = false) {
		this.#debug = debug;
	}

	onTurn(callback, priority = 10) {
		this.#processors.push({ callback, priority });
		this.#processors.sort((a, b) => a.priority - b.priority);
	}

	async processTurn(rummy) {
		for (const p of this.#processors) {
			const start = performance.now();
			await p.callback(rummy);
			if (this.#debug) {
				const duration = (performance.now() - start).toFixed(2);
				const name = p.callback.name ? p.callback.name : "anonymous";
				console.log(`[PIPELINE] Processor ${name} took ${duration}ms`);
			}
		}
	}

	addFilter(tag, callback, priority = 10) {
		if (!this.#filters.has(tag)) this.#filters.set(tag, []);
		this.#filters.get(tag).push({ callback, priority });
		this.#filters.get(tag).sort((a, b) => a.priority - b.priority);
	}

	async applyFilters(tag, value, ...args) {
		const hooks = this.#filters.get(tag);
		if (!hooks) return value;
		let result = value;
		for (const h of hooks) {
			result = await h.callback(result, ...args);
		}
		return result;
	}

	addEvent(tag, callback, priority = 10) {
		if (!this.#events.has(tag)) this.#events.set(tag, []);
		this.#events.get(tag).push({ callback, priority });
		this.#events.get(tag).sort((a, b) => a.priority - b.priority);
	}

	removeEvent(tag, callback) {
		const hooks = this.#events.get(tag);
		if (!hooks) return;
		const idx = hooks.findIndex((h) => h.callback === callback);
		if (idx !== -1) hooks.splice(idx, 1);
	}

	async emitEvent(tag, ...args) {
		const hooks = this.#events.get(tag);
		if (!hooks) return;
		for (const h of hooks) {
			await h.callback(...args);
		}
	}
}
