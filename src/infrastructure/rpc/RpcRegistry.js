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
		if (this.#methods.has(name))
			throw new Error(`RPC method '${name}' already registered.`);
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

	registerNotification(name, description = "") {
		this.#notifications.set(name, Object.freeze({ description }));
	}

	get(name) {
		return this.#methods.get(name);
	}

	has(name) {
		return this.#methods.has(name);
	}

	discover() {
		const methods = {};
		for (const [name, def] of this.#methods) {
			methods[name] = { description: def.description, params: def.params };
		}
		const notifications = {};
		for (const [name, def] of this.#notifications) {
			notifications[name] = { description: def.description };
		}
		return { methods, notifications };
	}
}
