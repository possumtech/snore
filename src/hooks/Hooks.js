import HookRegistry from "./HookRegistry.js";
import RpcRegistry from "./RpcRegistry.js";
import ToolRegistry from "./ToolRegistry.js";

/**
 * createHooks returns a structured, strictly-typed API for registering
 * and emitting hooks, removing the dynamic stringly-typed Proxy magic.
 */
export default function createHooks(debug = false) {
	const registry = new HookRegistry(debug);
	const tools = new ToolRegistry();

	const createEvent = (tag) => ({
		on: (callback, priority) => registry.addEvent(tag, callback, priority),
		off: (callback) => registry.removeEvent(tag, callback),
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
			created: createEvent("run.created"),
			started: createEvent("run.started"),
			state: createEvent("run.state"),
			config: createFilter("run.config"),
		},
		loop: {
			started: createEvent("loop.started"),
		},
		turn: {
			started: createEvent("turn.started"),
			response: createEvent("turn.response"),
			proposal: createEvent("turn.proposal"),
			proposing: createEvent("turn.proposing"),
			completed: createEvent("turn.completed"),
		},
		assembly: {
			system: createFilter("assembly.system"),
			user: createFilter("assembly.user"),
		},
		instructions: {
			toolDocs: createFilter("instructions.toolDocs"),
		},
		ask: {
			started: createEvent("ask.started"),
		},
		act: {
			started: createEvent("act.started"),
		},
		llm: {
			request: {
				started: createEvent("llm.request.started"),
				completed: createEvent("llm.request.completed"),
			},
			messages: createFilter("llm.messages"),
			response: createFilter("llm.response"),
			// Reasoning merge filter. Subscribers contribute per-tag
			// reasoning text (e.g. the think plugin's <think>…</think>)
			// to the model's reasoning_content field. Fires between parse
			// and turn.response.
			reasoning: createFilter("llm.reasoning"),
			// LLM provider registry. Plugins contribute entries shaped:
			//   {
			//     name: string,
			//     matches: (modelAlias) => boolean,
			//     completion: (messages, modelAlias, options) => Promise<response>,
			//     getContextSize: (modelAlias) => Promise<number>,
			//   }
			// Each provider owns a prefix namespace (e.g. "openai/", "ollama/",
			// "openrouter/"). LlmProvider picks the first provider whose
			// matches() returns true. No catchall — if a model alias doesn't
			// match any registered provider, the request fails with a clear
			// "no provider registered" error. External plugins add new
			// prefixes without namespace collision.
			providers: [],
		},
		file: {},
		prompt: {
			tools: createFilter("prompt.tools"),
		},
		entry: {
			recording: createFilter("entry.recording"),
			created: createEvent("entry.created"),
			changed: createEvent("entry.changed"),
		},
		tool: {
			before: createEvent("tool.before"),
			after: createEvent("tool.after"),
		},
		context: {
			materialized: createEvent("context.materialized"),
		},
		action: {},
		error: {
			log: createEvent("error.log"),
		},
		stream: {
			cancelled: createEvent("stream.cancelled"),
		},
		ui: {
			render: createEvent("ui.render"),
			notify: createEvent("ui.notify"),
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
			registry: new RpcRegistry(),
		},
		agent: {},
		tools,

		// Utility to add raw filters/events directly if needed for tests
		addFilter: registry.addFilter.bind(registry),
		applyFilters: registry.applyFilters.bind(registry),
		addEvent: registry.addEvent.bind(registry),
		emitEvent: registry.emitEvent.bind(registry),
	};
}
