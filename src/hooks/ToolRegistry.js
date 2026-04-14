// Tool display order: gather → reason → act → communicate.
// Position in the list implies priority to the model.
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
	"update",
	"summarize",
	"search",
];

function sortByPriority(names) {
	return names.toSorted((a, b) => {
		const ia = TOOL_ORDER.indexOf(a);
		const ib = TOOL_ORDER.indexOf(b);
		if (ia === -1 && ib === -1) return a.localeCompare(b);
		if (ia === -1) return 1;
		if (ib === -1) return 1;
		return ia - ib;
	});
}

export default class ToolRegistry {
	#tools = new Map();
	#handlers = new Map();
	#views = new Map();

	ensureTool(scheme) {
		if (this.#tools.has(scheme)) return;
		this.#tools.set(scheme, Object.freeze({}));
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

	onView(scheme, fn, fidelity = "promoted") {
		if (!this.#views.has(scheme)) this.#views.set(scheme, new Map());
		this.#views.get(scheme).set(fidelity, fn);
	}

	async view(scheme, entry) {
		const fidelityMap = this.#views.get(scheme);
		if (!fidelityMap) {
			throw new Error(
				`No view registered for scheme '${scheme}'. ` +
					`Every tool must define how its entries appear in the model view.`,
			);
		}

		const fidelity = entry.fidelity || "promoted";
		const fn = fidelityMap.get(fidelity);
		if (!fn) return "";

		return fn(entry);
	}

	hasView(scheme) {
		const fidelityMap = this.#views.get(scheme);
		return fidelityMap?.size > 0;
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

	/**
	 * Compute the active tool set for a loop.
	 * All exclusions — mode, flags — handled here. One mechanism.
	 */
	resolveForLoop(
		mode,
		{ noInteraction = false, noWeb = false, noProposals = false } = {},
	) {
		const excluded = new Set();
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
