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

	get hooks() {
		return this.#context.hooks || null;
	}

	get db() {
		return this.#context.db;
	}

	get entries() {
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

	get projectId() {
		return this.#context.projectId;
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

	async set({ path, body, state = "full", attributes } = {}) {
		if (!path) {
			const slugify = (await import("../sql/functions/slugify.js")).default;
			const base = slugify(body || "");
			path = `known://${base || Date.now()}`;
		}
		await this.entries.upsert(
			this.runId,
			this.sequence,
			path,
			body || "",
			state,
			attributes ? { attributes } : undefined,
		);
		return path;
	}

	async get(path) {
		await this.entries.promoteByPattern(this.runId, path, null, this.sequence);
	}

	async store(path) {
		await this.entries.demoteByPattern(this.runId, path, null);
	}

	async rm(path) {
		await this.entries.remove(this.runId, path);
	}

	async mv(from, to) {
		const body = await this.entries.getBody(this.runId, from);
		if (body === null) return;
		await this.entries.upsert(this.runId, this.sequence, to, body, "full");
		await this.entries.remove(this.runId, from);
	}

	async cp(from, to) {
		const body = await this.entries.getBody(this.runId, from);
		if (body === null) return;
		await this.entries.upsert(this.runId, this.sequence, to, body, "full");
	}

	// --- Plugin-only methods (superset) ---

	async getAttributes(path) {
		return this.entries.getAttributes(this.runId, path);
	}

	async getEntries(pattern, bodyFilter) {
		return this.entries.getEntriesByPattern(this.runId, pattern, bodyFilter);
	}

	async log(message) {
		const path = `content://${Date.now()}`;
		await this.entries.upsert(this.runId, this.sequence, path, message, "info");
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
