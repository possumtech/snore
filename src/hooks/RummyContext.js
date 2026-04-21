/**
 * RummyContext provides a unified, semantic API for plugins to interact with
 * the Turn node tree and core resources like the Database and Project metadata.
 */
// Entries write verbs that should automatically carry the caller's
// writer identity. Handler-issued writes on behalf of the model default
// to writer=model; plugin background writes (set via rummy from a hook
// with writer: "plugin" or "system" in ctx) get the context's writer.
const WRITE_VERBS = new Set(["set", "rm", "cp", "mv", "update"]);

// Defaults applied at construction so every plugin-facing getter
// returns a predictable shape without per-access fallbacks.
const CONTEXT_DEFAULTS = Object.freeze({
	hooks: null,
	activeFiles: [],
	sequence: 0,
	runId: null,
	turnId: null,
	loopId: null,
	toolSet: null,
	contextSize: null,
	systemPrompt: "",
	loopPrompt: "",
	writer: "model",
});

export default class RummyContext {
	#root;
	#context;
	#wrappedStore;

	constructor(root, context) {
		this.#root = root;
		this.#context = { ...CONTEXT_DEFAULTS, ...context };
	}

	get hooks() {
		return this.#context.hooks;
	}

	get db() {
		return this.#context.db;
	}

	get entries() {
		if (this.#wrappedStore) return this.#wrappedStore;
		const store = this.#context.store;
		if (!store) return null;
		const writer = this.writer;
		this.#wrappedStore = new Proxy(store, {
			get(target, prop) {
				const val = target[prop];
				if (typeof val !== "function") return val;
				if (!WRITE_VERBS.has(prop)) return val.bind(target);
				return (args = {}) => val.call(target, { writer, ...args });
			},
		});
		return this.#wrappedStore;
	}

	get project() {
		return this.#context.project;
	}

	get activeFiles() {
		return this.#context.activeFiles;
	}

	get type() {
		return this.#context.type;
	}

	get projectId() {
		return this.#context.projectId;
	}

	get sequence() {
		return this.#context.sequence;
	}

	get runId() {
		return this.#context.runId;
	}

	get turnId() {
		return this.#context.turnId;
	}

	get loopId() {
		return this.#context.loopId;
	}

	get noRepo() {
		return this.#context.noRepo === true;
	}

	get noInteraction() {
		return this.#context.noInteraction === true;
	}

	get noWeb() {
		return this.#context.noWeb === true;
	}

	get toolSet() {
		return this.#context.toolSet;
	}

	get contextSize() {
		return this.#context.contextSize;
	}

	get systemPrompt() {
		return this.#context.systemPrompt;
	}

	get loopPrompt() {
		return this.#context.loopPrompt;
	}

	/**
	 * Writer identity for Entries permission checks. Defaults to
	 * 'model' — handlers write on behalf of the model's emitted command.
	 * Non-handler plugin code (streaming callbacks, background emissions)
	 * passes `writer: 'plugin'` or `'system'` explicitly.
	 */
	get writer() {
		return this.#context.writer;
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

	async set({
		path,
		body = "",
		state = "resolved",
		outcome = null,
		fidelity,
		attributes,
	} = {}) {
		if (!path) {
			path = await this.entries.slugPath(
				this.runId,
				"known",
				body,
				attributes?.summary,
			);
		}
		await this.entries.set({
			runId: this.runId,
			turn: this.sequence,
			path,
			body,
			state,
			outcome,
			fidelity,
			attributes,
			loopId: this.loopId,
		});
		return path;
	}

	async get(path) {
		await this.entries.get({
			runId: this.runId,
			turn: this.sequence,
			path: path,
			bodyFilter: null,
		});
	}

	async rm(path) {
		await this.entries.rm({ runId: this.runId, path: path });
	}

	async update(body, { status = 102, attributes = {} } = {}) {
		return this.entries.update({
			runId: this.runId,
			turn: this.sequence,
			body,
			status,
			attributes,
			loopId: this.loopId,
		});
	}

	async mv(from, to) {
		const body = await this.entries.getBody(this.runId, from);
		if (body === null) return;
		await this.entries.set({
			runId: this.runId,
			turn: this.sequence,
			path: to,
			body,
			state: "resolved",
			loopId: this.loopId,
		});
		await this.entries.rm({ runId: this.runId, path: from });
	}

	async cp(from, to) {
		const body = await this.entries.getBody(this.runId, from);
		if (body === null) return;
		await this.entries.set({
			runId: this.runId,
			turn: this.sequence,
			path: to,
			body,
			state: "resolved",
			loopId: this.loopId,
		});
	}

	// --- Plugin-only methods (superset) ---

	async getBody(path) {
		return this.entries.getBody(this.runId, path);
	}

	async getAttributes(path) {
		return this.entries.getAttributes(this.runId, path);
	}

	async getState(path) {
		const row = await this.entries.getState(this.runId, path);
		if (!row) return null;
		return row.state;
	}

	async getOutcome(path) {
		const row = await this.entries.getState(this.runId, path);
		if (!row) return null;
		return row.outcome;
	}

	async getEntry(path) {
		const results = await this.entries.getEntriesByPattern(
			this.runId,
			path,
			null,
		);
		if (results.length === 0) return null;
		return results[0];
	}

	async setAttributes(path, attrs) {
		return this.entries.set({
			runId: this.runId,
			path: path,
			attributes: attrs,
		});
	}

	async getEntries(pattern, bodyFilter) {
		return this.entries.getEntriesByPattern(this.runId, pattern, bodyFilter);
	}

	async log(message) {
		const path = `content://${Date.now()}`;
		await this.entries.set({
			runId: this.runId,
			turn: this.sequence,
			path,
			body: message,
			state: "resolved",
		});
	}

	// --- Node tree methods ---

	tag(name, attrs = {}, children = []) {
		const node = { tag: name, attrs, content: null, children: [] };
		const childArray = Array.isArray(children) ? children : [children];
		for (const child of childArray) {
			if (typeof child === "string") {
				if (node.content === null) node.content = "";
				node.content += child;
			} else if (child && typeof child === "object") {
				node.children.push(child);
			}
		}
		return node;
	}
}
