import TodoParser from "../../application/agent/TodoParser.js";

/**
 * Turn: The thin JS glue representing a single orchestration round.
 * The database is the single source of truth.
 */
export default class Turn {
	#db;
	#turnId;
	#data = null;

	constructor(db, turnId) {
		this.#db = db;
		this.#turnId = turnId;
	}

	get id() {
		return this.#turnId;
	}

	/**
	 * Hydrates the turn data from the database.
	 */
	async hydrate() {
		const elements =
			(await this.#db?.get_turn_elements.all({
				turn_id: this.#turnId,
			})) || [];

		// Build flat map for O(1) tag access
		const tagMap = new Map();
		const allNodes = [];

		for (const el of elements) {
			const node = {
				...el,
				attributes: JSON.parse(el.attributes || "{}"),
				children: [],
			};
			allNodes.push(node);
			if (!tagMap.has(el.tag_name)) tagMap.set(el.tag_name, []);
			tagMap.get(el.tag_name).push(node);
		}

		// Rebuild parent-child links for XML serialization
		const nodeLookup = new Map(allNodes.map((n) => [n.id, n]));
		const root = [];
		for (const node of allNodes) {
			if (node.parent_id === null) {
				root.push(node);
			} else {
				const parent = nodeLookup.get(node.parent_id);
				if (parent) parent.children.push(node);
			}
		}

		this.#data = { root, tagMap };
		return this;
	}

	/**
	 * Serializes the turn for the Client (JSON-RPC).
	 */
	toJson() {
		if (!this.#data) throw new Error("Turn not hydrated.");
		const { tagMap, root } = this.#data;

		const getTag = (name) => tagMap.get(name)?.[0];
		const getTags = (name) => tagMap.get(name) || [];

		const turnNode = root[0]; // The root is always the <turn> element
		const assistantNode = getTag("assistant");
		const contextNode = getTag("context");

		const getDeepContent = (node) => {
			if (!node) return null;
			if (node.content !== null) return node.content;
			return node.children
				.map((c) => getDeepContent(c))
				.filter((v) => v !== null)
				.join("\n");
		};

		const getChildContent = (parent, tagName) => {
			const el = parent?.children.find((c) => c.tag_name === tagName);
			return getDeepContent(el);
		};

		const meta = JSON.parse(getChildContent(assistantNode, "meta") || "{}");
		const todoRaw = getChildContent(assistantNode, "todo") || "";
		const { list: todo, next: next_todo } = TodoParser.parse(todoRaw);

		// FETCH SEQUENCE FROM ROOT TURN NODE ATTRIBUTES OR SQL DATA
		const rawSeq = turnNode?.attributes?.sequence ?? turnNode?.sequence ?? 0;
		const sequence = Number.parseInt(String(rawSeq), 10);

		return {
			sequence: Number.isNaN(sequence) ? 0 : sequence,
			system: (() => {
				const sys = getTag("system");
				if (!sys) return "";
				let s = sys.content || "";
				for (const child of sys.children) s += this.toXml(child);
				return s;
			})(),
			user: getDeepContent(getTag("user")) || "",
			context: contextNode ? this.toXml(contextNode) : "",
			errors: getTags("error").map((t) => ({
				content: t.content,
				...t.attributes,
			})),
			warnings: getTags("warn").map((t) => ({
				content: t.content,
				...t.attributes,
			})),
			infos: getTags("info").map((t) => ({
				content: t.content,
				...t.attributes,
			})),
			files: getTags("file").map((f) => {
				const source = f.children.find((c) => c.tag_name === "source");
				const symbols = f.children.find((c) => c.tag_name === "symbols");
				return {
					path: f.attributes.path,
					size: f.attributes.size,
					tokens: f.attributes.tokens,
					content: source ? source.content : null,
					symbols: symbols ? symbols.content?.split("\t") : null,
				};
			}),
			assistant: {
				content: getChildContent(assistantNode, "content"),
				reasoning_content: getChildContent(assistantNode, "reasoning_content"),
				todo,
				next_todo,
				known: getChildContent(assistantNode, "known"),
				unknown: getChildContent(assistantNode, "unknown"),
				summary: getChildContent(assistantNode, "summary"),
			},
			usage: {
				prompt_tokens: meta.prompt_tokens || 0,
				completion_tokens: meta.completion_tokens || 0,
				total_tokens: meta.total_tokens || 0,
			},
			model: {
				alias: meta.alias,
				actual: meta.actualModel,
				display: meta.displayModel,
			},
		};
	}

	/**
	 * Serializes the turn for the LLM history.
	 */
	/**
	 * Serializes the turn for the LLM history.
	 * @param {object} opts
	 * @param {boolean} opts.forHistory - If true, omits system message and
	 *   strips context XML from user message. Prior turns' context is stale —
	 *   only the current turn should include live file contents and git state.
	 */
	async serialize({ forHistory = false } = {}) {
		if (!this.#data) await this.hydrate();
		const json = this.toJson();

		const messages = [];

		if (!forHistory) {
			// System = identity text + document children (rendered as XML)
			const systemNode = this.#data.root[0]?.children.find(
				(c) => c.tag_name === "system",
			);
			if (systemNode) {
				let systemContent = systemNode.content || "";
				for (const child of systemNode.children) {
					systemContent += this.toXml(child);
				}
				if (systemContent) {
					messages.push({ role: "system", content: systemContent });
				}
			}
		}

		// User = feedback (context children) + prompt
		const contextNode = this.#data.root[0]?.children.find(
			(c) => c.tag_name === "context",
		);
		const userNode = this.#data.root[0]?.children.find(
			(c) => c.tag_name === "user",
		);
		const userXml = userNode ? this.toXml(userNode) : json.user || "";

		if (forHistory) {
			if (userXml) messages.push({ role: "user", content: userXml });
		} else {
			let feedback = "";
			if (contextNode) {
				for (const child of contextNode.children) {
					feedback += this.toXml(child);
				}
			}
			const userContent = feedback + userXml;
			if (userContent) messages.push({ role: "user", content: userContent });
		}

		if (json.assistant.content) {
			messages.push({ role: "assistant", content: json.assistant.content });
		}

		return messages;
	}

	/**
	 * Renders a node and its children to faithful XML.
	 */
	toXml(node = null) {
		if (!node && this.#data) node = this.#data.root[0];
		if (!node) return "";

		let xml = `<${node.tag_name}`;
		for (const [k, v] of Object.entries(node.attributes)) {
			xml += ` ${k}="${this.#escapeXml(String(v))}"`;
		}

		if (node.content === null && node.children.length === 0) {
			return `${xml}/>\n`;
		}

		xml += ">";
		if (node.content !== null) xml += node.content;
		for (const child of node.children) {
			xml += this.toXml(child);
		}
		xml += `</${node.tag_name}>\n`;
		return xml;
	}

	#escapeXml(unsafe) {
		return unsafe.replace(/[<>&"']/g, (c) => {
			switch (c) {
				case "<":
					return "&lt;";
				case ">":
					return "&gt;";
				case "&":
					return "&amp;";
				case '"':
					return "&quot;";
				case "'":
					return "&apos;";
			}
			return c;
		});
	}
}
