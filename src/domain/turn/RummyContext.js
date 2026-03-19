/**
 * RummyContext provides a unified, semantic API for plugins to interact with
 * the Turn XML Document and core resources like the Database and Project metadata.
 */
export default class RummyContext {
	#doc;
	#context;

	constructor(doc, context) {
		this.#doc = doc;
		this.#context = context;
	}

	/**
	 * Access to the raw XML Document.
	 */
	get doc() {
		return this.#doc;
	}

	/**
	 * Access to the project's SQLite database.
	 */
	get db() {
		return this.#context.db;
	}

	/**
	 * Metadata for the current project (id, path, name).
	 */
	get project() {
		return this.#context.project;
	}

	/**
	 * List of files currently "active" or focused in the UI.
	 */
	get activeFiles() {
		return this.#context.activeFiles || [];
	}

	get type() {
		return this.#context.type;
	}

	get sessionId() {
		return this.#context.sessionId;
	}

	/**
	 * Semantic access to standard XML sections.
	 */
	get system() {
		return this.#doc.getElementsByTagName("system")[0];
	}

	get contextEl() {
		return this.#doc.getElementsByTagName("context")[0];
	}

	get user() {
		return this.#doc.getElementsByTagName("user")[0];
	}

	get assistant() {
		return this.#doc.getElementsByTagName("assistant")[0];
	}

	/**
	 * Creates a new XML element (Tag) with attributes and children.
	 */
	tag(name, attrs = {}, children = []) {
		const el = this.#doc.createElement(name);
		for (const [k, v] of Object.entries(attrs)) {
			el.setAttribute(k, v);
		}

		const childArray = Array.isArray(children) ? children : [children];
		for (const child of childArray) {
			if (typeof child === "string") {
				el.appendChild(this.#doc.createTextNode(child));
			} else if (child && typeof child === "object") {
				el.appendChild(child);
			}
		}
		return el;
	}
}
