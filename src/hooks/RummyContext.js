/**
 * RummyContext provides a unified, semantic API for plugins to interact with
 * the Turn node tree and core resources like the Database and Project metadata.
 */
export default class RummyContext {
	#root;
	#context;

	constructor(root, context) {
		this.#root = root;
		this.#context = context;
	}

	get db() {
		return this.#context.db;
	}

	get store() {
		return this.#context.store || null;
	}

	get project() {
		return this.#context.project;
	}

	get activeFiles() {
		return this.#context.activeFiles || [];
	}

	get type() {
		return this.#context.type;
	}

	get sessionId() {
		return this.#context.sessionId;
	}

	get sequence() {
		return this.#context.sequence || 0;
	}

	get runId() {
		return this.#context.runId || null;
	}

	get turnId() {
		return this.#context.turnId || null;
	}

	get noContext() {
		return this.#context.noContext === true;
	}

	get contextSize() {
		return this.#context.contextSize || null;
	}

	get systemPrompt() {
		return this.#context.systemPrompt || "";
	}

	get loopPrompt() {
		return this.#context.loopPrompt || "";
	}

	get system() {
		return this.#root.children.find((c) => c.tag === "system");
	}

	get contextEl() {
		return this.#root.children.find((c) => c.tag === "context");
	}

	get user() {
		return this.#root.children.find((c) => c.tag === "user");
	}

	get assistant() {
		return this.#root.children.find((c) => c.tag === "assistant");
	}

	tag(name, attrs = {}, children = []) {
		const node = { tag: name, attrs, content: null, children: [] };
		const childArray = Array.isArray(children) ? children : [children];
		for (const child of childArray) {
			if (typeof child === "string") {
				node.content = (node.content || "") + child;
			} else if (child && typeof child === "object") {
				node.children.push(child);
			}
		}
		return node;
	}
}
