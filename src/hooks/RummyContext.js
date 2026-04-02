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

	// --- Tool methods (same operations the model uses) ---

	async write({ path, value, state = "full", meta } = {}) {
		if (!path) {
			const slugify = (await import("../sql/functions/slugify.js")).default;
			const base = slugify(value || "");
			path = `known://${base || Date.now()}`;
		}
		await this.store.upsert(
			this.runId,
			this.sequence,
			path,
			value || "",
			state,
			meta ? { meta } : undefined,
		);
		return path;
	}

	async read(path) {
		await this.store.promoteByPattern(this.runId, path, null, this.sequence);
	}

	async storePath(path) {
		await this.store.demoteByPattern(this.runId, path, null);
	}

	async delete(path) {
		await this.store.remove(this.runId, path);
	}

	async move(from, to) {
		const value = await this.store.getValue(this.runId, from);
		if (value === null) return;
		await this.store.upsert(this.runId, this.sequence, to, value, "full");
		await this.store.remove(this.runId, from);
	}

	async copy(from, to) {
		const value = await this.store.getValue(this.runId, from);
		if (value === null) return;
		await this.store.upsert(this.runId, this.sequence, to, value, "full");
	}

	// --- Plugin-only methods (superset) ---

	async getMeta(path) {
		return this.store.getMeta(this.runId, path);
	}

	async getEntries(pattern, valueFilter) {
		return this.store.getEntriesByPattern(this.runId, pattern, valueFilter);
	}

	async log(message) {
		const path = `content://${Date.now()}`;
		await this.store.upsert(this.runId, this.sequence, path, message, "info");
	}

	// --- Node tree methods ---

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
