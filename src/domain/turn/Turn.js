import { extname } from "node:path";

const EXT_LANG = {
	".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
	".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
	".java": "java", ".kt": "kotlin", ".cs": "csharp", ".cpp": "cpp",
	".c": "c", ".h": "c", ".hpp": "cpp", ".lua": "lua", ".sh": "bash",
	".sql": "sql", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
	".toml": "toml", ".xml": "xml", ".html": "html", ".css": "css",
	".md": "markdown", ".swift": "swift", ".php": "php", ".r": "r",
};

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

	async hydrate() {
		const elements =
			(await this.#db?.get_turn_elements.all({
				turn_id: this.#turnId,
			})) || [];

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

	toJson() {
		if (!this.#data) throw new Error("Turn not hydrated.");
		const { tagMap, root } = this.#data;

		const getTag = (name) => tagMap.get(name)?.[0];
		const getTags = (name) => tagMap.get(name) || [];

		const turnNode = root[0];
		const assistantNode = getTag("assistant");

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
		const contentRaw = getChildContent(assistantNode, "content") || "";

		let todo = [];
		let next_todo = null;
		try {
			let jsonContent = contentRaw.trim();
			if (jsonContent.startsWith("```")) {
				jsonContent = jsonContent
					.replace(/^```(?:json)?\s*\n?/, "")
					.replace(/\n?```\s*$/, "");
			}
			const parsed = JSON.parse(jsonContent);
			todo = (parsed.todo || []).map((t) => ({
				tool: t.tool,
				argument: t.argument,
				description: t.description,
			}));
			next_todo = todo[0] || null;
		} catch {
			todo = [];
		}

		const rawSeq = turnNode?.attributes?.sequence ?? turnNode?.sequence ?? 0;
		const sequence = Number.parseInt(String(rawSeq), 10);

		const feedback = getTags("feedback").flatMap((f) =>
			(f.content || "")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const match = line.match(/^(info|warn|error):\s*(.+?)\s*#\s*(.+)$/);
					if (match)
						return {
							level: match[1],
							target: match[2],
							message: match[3].trim(),
						};
					return { level: "info", target: "", message: line.trim() };
				}),
		);

		return {
			sequence: Number.isNaN(sequence) ? 0 : sequence,
			system: (() => {
				const sys = getTag("system");
				if (!sys) return "";
				let s = sys.content || "";
				for (const child of sys.children) s += this.#renderNode(child);
				return s;
			})(),
			user: getDeepContent(getTag("user")) || "",
			context: (() => {
				const ctx = getTag("context");
				if (!ctx) return "";
				return ctx.children.map((c) => this.#renderNode(c)).join("");
			})(),
			feedback,
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
			files: getTags("document").map((d) => {
				const source = d.children.find((c) => c.tag_name === "source");
				const docContent = d.children.find((c) => c.tag_name === "document_content");
				return {
					path: source?.content || d.attributes.path,
					visibility: d.attributes.visibility,
					content: docContent?.content || null,
				};
			}),
			assistant: {
				content: getChildContent(assistantNode, "content"),
				reasoning_content: getChildContent(assistantNode, "reasoning_content"),
				todo,
				next_todo,
				known: JSON.parse(getChildContent(assistantNode, "known") || "[]"),
				unknown: JSON.parse(getChildContent(assistantNode, "unknown") || "[]"),
				summary: getChildContent(assistantNode, "summary"),
			},
			usage: {
				prompt_tokens: meta.prompt_tokens || 0,
				completion_tokens: meta.completion_tokens || 0,
				total_tokens: meta.total_tokens || 0,
				cost: meta.cost || 0,
				temperature: meta.temperature ?? null,
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
	 * @param {object} opts
	 * @param {boolean} opts.forHistory - If true, omits system message and
	 *   strips context from user message. Prior turns' context is stale —
	 *   only the current turn should include live file contents and git state.
	 */
	async serialize({ forHistory = false } = {}) {
		if (!this.#data) await this.hydrate();
		const json = this.toJson();

		const messages = [];

		if (!forHistory) {
			const systemNode = this.#data.root[0]?.children.find(
				(c) => c.tag_name === "system",
			);
			if (systemNode) {
				let systemContent = systemNode.content || "";
				for (const child of systemNode.children) {
					systemContent += this.#renderNode(child);
				}
				if (systemContent) {
					messages.push({ role: "system", content: systemContent });
				}
			}
		}

		const contextNode = this.#data.root[0]?.children.find(
			(c) => c.tag_name === "context",
		);
		const userContent = json.user || "";

		if (forHistory) {
			if (userContent) messages.push({ role: "user", content: userContent });
		} else {
			let contextMd = "";
			if (contextNode) {
				for (const child of contextNode.children) {
					contextMd += this.#renderNode(child);
				}
			}
			const fullUser = contextMd + userContent;
			if (fullUser) messages.push({ role: "user", content: fullUser });
		}

		if (json.assistant.content) {
			messages.push({ role: "assistant", content: json.assistant.content });
		}

		return messages;
	}

	/**
	 * Renders a node tree to Markdown.
	 */
	#renderNode(node) {
		if (!node) return "";
		const tag = node.tag_name;

		if (tag === "documents") {
			return "\n# Project Files\n\n" +
				node.children.map((c) => this.#renderNode(c)).join("\n");
		}

		if (tag === "document") {
			const source = node.children.find((c) => c.tag_name === "source");
			const docContent = node.children.find((c) => c.tag_name === "document_content");
			const path = source?.content || "";
			const visibility = node.attributes.visibility || "path";

			if (visibility === "path") {
				return `### \`${path}\`\n`;
			}

			if (visibility === "symbols") {
				return `### \`${path}\` (symbols)\n${docContent?.content || ""}\n`;
			}

			const lang = EXT_LANG[extname(path)] || "";
			const content = docContent?.content || "";
			return `### \`${path}\`\n\`\`\`${lang}\n${content}\n\`\`\`\n`;
		}

		if (tag === "feedback") {
			return (node.content || "")
				.split("\n")
				.filter(Boolean)
				.map((line) => `> ${line}`)
				.join("\n") + "\n\n";
		}

		if (tag === "modified_files" || tag === "git_changes") {
			return `## Modified Files\n${node.content || ""}\n\n`;
		}

		if (tag === "error") {
			return `> **Error**: ${node.content || ""}\n\n`;
		}

		// Generic fallback
		let md = node.content || "";
		for (const child of node.children) {
			md += this.#renderNode(child);
		}
		return md;
	}
}
