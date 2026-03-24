import HookRegistry from "./HookRegistry.js";

/**
 * createHooks returns a structured, strictly-typed API for registering
 * and emitting hooks, removing the dynamic stringly-typed Proxy magic.
 */
export default function createHooks(debug = false) {
	const registry = new HookRegistry(debug);

	const createEvent = (tag) => ({
		on: (callback, priority) => registry.addEvent(tag, callback, priority),
		emit: (...args) => registry.emitEvent(tag, ...args),
	});

	const createFilter = (tag) => ({
		addFilter: (callback, priority) =>
			registry.addFilter(tag, callback, priority),
		filter: (value, ...args) => registry.applyFilters(tag, value, ...args),
	});

	return {
		// Core Turn Pipeline
		onTurn: registry.onTurn.bind(registry),
		processTurn: registry.processTurn.bind(registry),

		// Explicit Hook Schema
		project: {
			init: {
				started: createEvent("project.init.started"),
				completed: createEvent("project.init.completed"),
			},
			files: {
				update: {
					started: createEvent("project.files.update.started"),
					completed: createEvent("project.files.update.completed"),
				},
			},
		},
		run: {
			started: createEvent("run.started"),
			progress: createEvent("run.progress"),
			config: createFilter("run.config"),
			turn: {
				...createFilter("run.turn"),
				audit: createEvent("run.turn.audit"),
			},
			step: {
				completed: createEvent("run.step.completed"),
			},
		},
		ask: {
			started: createEvent("ask.started"),
			completed: createEvent("ask.completed"),
		},
		act: {
			started: createEvent("act.started"),
			completed: createEvent("act.completed"),
		},
		llm: {
			request: {
				started: createEvent("llm.request.started"),
				completed: createEvent("llm.request.completed"),
			},
			messages: createFilter("llm.messages"),
			response: createFilter("llm.response"),
		},
		ui: {
			render: createEvent("ui.render"),
			notify: createEvent("ui.notify"),
			prompt: createEvent("ui.prompt"),
		},
		editor: {
			diff: createEvent("editor.diff"),
		},
		socket: {
			message: {
				raw: createFilter("socket.message.raw"),
			},
		},
		rpc: {
			started: createEvent("rpc.started"),
			completed: createEvent("rpc.completed"),
			error: createEvent("rpc.error"),
			request: createFilter("rpc.request"),
			response: {
				result: createFilter("rpc.response.result"),
			},
		},

		// Utility to add raw filters/events directly if needed for tests
		addFilter: registry.addFilter.bind(registry),
		applyFilters: registry.applyFilters.bind(registry),
		addEvent: registry.addEvent.bind(registry),
		emitEvent: registry.emitEvent.bind(registry),
	};
}
