import HookRegistry from "./HookRegistry.js";
import RpcRegistry from "./RpcRegistry.js";
import ToolRegistry from "./ToolRegistry.js";

// Strictly-typed hook surface; replaces the previous Proxy magic.
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
		boot: {
			// Post-init, pre-accept-connections; one-shot post-init actions subscribe here.
			completed: createEvent("boot.completed"),
		},
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
			config: createFilter("run.config"),
			step: {
				completed: createEvent("run.step.completed"),
			},
			// Fire-and-forget wake: any plugin that wants to deliver a new
			// prompt onto a (possibly dormant) run emits with
			// {runAlias, body, mode}. AgentLoop subscribes and runs inject —
			// writes prompt://<nextTurn>, enqueues a loop, ensures the
			// drainer is up. This is the "streaming child closed after the
			// loop ended" rendezvous: the producer doesn't care whether the
			// run is alive or asleep, just that the prompt reaches it.
			wake: createEvent("run.wake"),
		},
		loop: {
			started: createEvent("loop.started"),
			completed: createEvent("loop.completed"),
		},
		turn: {
			started: createEvent("turn.started"),
			// Pre-LLM packet shaping. Filter chain: subscribers receive
			// `{ messages, rows, contextSize, lastPromptTokens,
			// assembledTokens, ok, overflow }` and return a transformed
			// packet. Budget plugin participates here to enforce ceilings
			// (may demote, may set ok=false on overflow). Other plugins
			// could trim, re-order, or annotate — same surface.
			beforeDispatch: createFilter("turn.beforeDispatch"),
			response: createEvent("turn.response"),
			// Post-dispatch event. Fired after the per-entry dispatch
			// loop, before turn.completed. Budget subscribes here for
			// post-dispatch demotion / 413 overflow detection.
			dispatched: createEvent("turn.dispatched"),
			completed: createEvent("turn.completed"),
			// Verdict filter chain: each subscriber receives the current
			// verdict object and returns a (possibly modified) one.
			// Initial value is { continue: true }; final value drives the
			// loop's continue/abandon decision. Multi-plugin: strike streak,
			// cycle detect, stagnation pressure, future voters all
			// participate via this surface.
			verdict: createFilter("turn.verdict"),
		},
		// SPEC #resolution covers the proposal hook chain.
		proposal: {
			prepare: createEvent("proposal.prepare"),
			pending: createEvent("proposal.pending"),
			accepting: createFilter("proposal.accepting"),
			content: createFilter("proposal.content"),
			accepted: createEvent("proposal.accepted"),
			rejected: createEvent("proposal.rejected"),
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
			// Plugins contribute reasoning text into reasoning_content; fires between parse and turn.response.
			reasoning: createFilter("llm.reasoning"),
			// Provider entries: { name, matches, completion, getContextSize }.
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

		addFilter: registry.addFilter.bind(registry),
		applyFilters: registry.applyFilters.bind(registry),
		addEvent: registry.addEvent.bind(registry),
		emitEvent: registry.emitEvent.bind(registry),
	};
}
