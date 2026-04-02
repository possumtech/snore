export default class ToolRegistry {
	#tools = new Map();

	register(name, definition) {
		if (this.#tools.has(name))
			throw new Error(`Tool '${name}' already registered.`);
		this.#tools.set(name, Object.freeze(definition));
	}

	get(name) {
		return this.#tools.get(name);
	}

	has(name) {
		return this.#tools.has(name);
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
