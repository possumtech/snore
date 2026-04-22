// Tool display order: gather → reason → act → communicate.
// Position in the list implies priority to the model.
// `update` is pinned last — it's the turn-closer, not an action.
const TOOL_ORDER = [
	"think",
	"unknown",
	"known",
	"get",
	"set",
	"env",
	"sh",
	"rm",
	"cp",
	"mv",
	"ask_user",
	"search",
];

function sortByPriority(names) {
	return names.toSorted((a, b) => {
		if (a === "update") return 1;
		if (b === "update") return -1;
		const ia = TOOL_ORDER.indexOf(a);
		const ib = TOOL_ORDER.indexOf(b);
		if (ia === -1 && ib === -1) return a.localeCompare(b);
		if (ia === -1) return 1;
		if (ib === -1) return -1;
		return ia - ib;
	});
}

export default class ToolRegistry {
	#tools = new Map();
	#handlers = new Map();
	#views = new Map();
	#hidden = new Set();

	ensureTool(scheme) {
		if (this.#tools.has(scheme)) return;
		this.#tools.set(scheme, Object.freeze({}));
	}

	// Hidden tools dispatch on direct emission but don't appear in any
	// model-facing tool list. Internal schemes (e.g. <known>, <unknown>)
	// the model writes via <set path="scheme://..."> instead.
	markHidden(scheme) {
		this.#hidden.add(scheme);
	}

	get(name) {
		return this.#tools.get(name);
	}

	has(name) {
		return this.#tools.has(name);
	}

	onHandle(scheme, handler, priority = 10) {
		if (!this.#handlers.has(scheme)) this.#handlers.set(scheme, []);
		const list = this.#handlers.get(scheme);
		list.push({ handler, priority });
		list.sort((a, b) => a.priority - b.priority);
	}

	onView(scheme, fn, visibility = "visible") {
		if (!this.#views.has(scheme)) this.#views.set(scheme, new Map());
		this.#views.get(scheme).set(visibility, fn);
	}

	async view(scheme, entry) {
		const visibilityMap = this.#views.get(scheme);
		if (!visibilityMap) {
			throw new Error(
				`No view registered for scheme '${scheme}'. ` +
					`Every tool must define how its entries appear in the model view.`,
			);
		}

		const visibility =
			entry.visibility === undefined ? "visible" : entry.visibility;
		const fn = visibilityMap.get(visibility);
		if (!fn) return "";

		const body = await fn(entry);
		// View handlers MAY return undefined or null to mean "no projected
		// body at this visibility" — normalize at this boundary so callers
		// get a predictable string.
		return body == null ? "" : body;
	}

	hasView(scheme) {
		const visibilityMap = this.#views.get(scheme);
		return visibilityMap?.size > 0;
	}

	async dispatch(scheme, entry, rummy) {
		const list = this.#handlers.get(scheme);
		if (!list) return;
		for (const { handler } of list) {
			const result = await handler(entry, rummy);
			if (result === false) break;
		}
	}

	get names() {
		return sortByPriority([...this.#tools.keys()]);
	}

	// Names advertised to the model — registered tools minus hidden ones.
	// Use this anywhere a tool list is shown to the model.
	get advertisedNames() {
		return sortByPriority(
			[...this.#tools.keys()].filter((n) => !this.#hidden.has(n)),
		);
	}

	/**
	 * Compute the active tool set for a loop.
	 * All exclusions — mode, flags, hidden — handled here. One mechanism.
	 */
	resolveForLoop(
		mode,
		{ noInteraction = false, noWeb = false, noProposals = false } = {},
	) {
		const excluded = new Set(this.#hidden);
		if (mode === "ask") excluded.add("sh");
		if (noInteraction) excluded.add("ask_user");
		if (noWeb) excluded.add("search");
		if (noProposals) {
			excluded.add("ask_user");
			excluded.add("env");
			excluded.add("sh");
		}
		const names = sortByPriority(
			[...this.#tools.keys()].filter((n) => !excluded.has(n)),
		);
		return new Set(names);
	}

	entries() {
		return this.#tools.entries();
	}
}
