import HookRegistry from "./HookRegistry.js";

/**
 * createHooks returns a proxy-based wrapper around HookRegistry.
 * This allows for a nested, fluent API:
 *   hooks.category.action.emit(payload)
 *   hooks.category.filter.filter(value, context)
 *
 * It also provides access to the core registry methods:
 *   hooks.onTurn(callback)
 *   hooks.processTurn(doc, context, h)
 */
export default function createHooks(debug = false) {
	const registry = new HookRegistry(debug);

	const createProxy = (path = []) => {
		const target = () => {};

		// Core Registry methods on the root only
		if (path.length === 0) {
			target.onTurn = registry.onTurn.bind(registry);
			target.processTurn = registry.processTurn.bind(registry);
			target.addFilter = registry.addFilter.bind(registry);
			target.applyFilters = registry.applyFilters.bind(registry);
			target.addEvent = registry.addEvent.bind(registry);
			target.emitEvent = registry.emitEvent.bind(registry);
		}

		return new Proxy(target, {
			get(obj, prop) {
				// Return existing root methods
				if (path.length === 0 && prop in obj) return obj[prop];

				// Special handlers for proxy termination
				if (prop === "filter") {
					return (value, ...args) =>
						registry.applyFilters(path.join("."), value, ...args);
				}
				if (prop === "addFilter") {
					return (callback, priority) =>
						registry.addFilter(path.join("."), callback, priority);
				}
				if (prop === "emit") {
					return (...args) => registry.emitEvent(path.join("."), ...args);
				}
				if (prop === "on") {
					return (callback, priority) =>
						registry.addEvent(path.join("."), callback, priority);
				}

				return createProxy([...path, prop]);
			},
			apply(_target, _thisArg, args) {
				return createProxy([...path, ...args]);
			},
		});
	};

	return createProxy();
}
