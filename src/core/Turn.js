import { XMLSerializer } from "@xmldom/xmldom";

/**
 * The Turn class represents the structured Document of a single LLM round.
 */
export default class Turn {
	#doc;
	#serializer = new XMLSerializer();

	constructor(doc) {
		this.#doc = doc;
	}

	get doc() {
		return this.#doc;
	}

	/**
	 * Returns helpers for the assistant section.
	 */
	get assistant() {
		const assistantEl = this.#doc.getElementsByTagName("assistant")[0];
		const h = (tagName) => {
			let el = assistantEl.getElementsByTagName(tagName)[0];
			if (!el) {
				el = this.#doc.createElement(tagName);
				assistantEl.appendChild(el);
			}
			return {
				add: (content) => {
					if (typeof content === "string") {
						el.appendChild(this.#doc.createTextNode(content));
					} else {
						el.appendChild(this.#doc.createTextNode(JSON.stringify(content)));
					}
				},
			};
		};

		return {
			reasoning: h("reasoning_content"),
			content: h("content"),
			meta: h("meta"),
		};
	}

	/**
	 * Serializes only the request portions for the OpenAI messages array.
	 * Currently handles System and User roles.
	 */
	async serialize() {
		const systemEl = this.#doc.getElementsByTagName("system")[0];
		const contextEl = this.#doc.getElementsByTagName("context")[0];
		const userEl = this.#doc.getElementsByTagName("user")[0];

		// system role = <system> + <context>
		const systemContent = [
			this.#serializeNode(systemEl),
			this.#serializeNode(contextEl),
		]
			.filter(Boolean)
			.join("\n");

		// user role = <user>
		const userContent = this.#serializeNode(userEl);

		return [
			{ role: "system", content: systemContent },
			{ role: "user", content: userContent },
		];
	}

	/**
	 * Serializes the entire turn into a structured JSON object for the client.
	 */
	toJson() {
		const systemEl = this.#doc.getElementsByTagName("system")[0];
		const contextEl = this.#doc.getElementsByTagName("context")[0];
		const userEl = this.#doc.getElementsByTagName("user")[0];
		const assistantEl = this.#doc.getElementsByTagName("assistant")[0];

		const getTagContent = (parent, tagName) => {
			const el = parent?.getElementsByTagName(tagName)[0];
			return el ? el.textContent : null;
		};

		const assistantMeta = JSON.parse(
			getTagContent(assistantEl, "meta") || "{}",
		);
		const usage = assistantMeta.usage || {
			prompt_tokens: assistantMeta.prompt_tokens || 0,
			completion_tokens: assistantMeta.completion_tokens || 0,
			total_tokens: assistantMeta.total_tokens || 0,
		};

		return {
			sequence: Number.parseInt(
				this.#doc.documentElement.getAttribute("sequence") || "0",
				10,
			),
			system: systemEl?.textContent || "",
			context: this.#serializePretty(contextEl),
			user: userEl?.textContent || "",
			assistant: {
				content: getTagContent(assistantEl, "content"),
				reasoning: getTagContent(assistantEl, "reasoning_content"),
			},
			usage,
			model: {
				alias: assistantMeta.alias,
				actual: assistantMeta.actualModel,
			},
		};
	}

	/**
	 * Serializes the entire turn into a pretty-printed XML document.
	 */
	toXml() {
		return this.#serializePretty(this.#doc.documentElement);
	}

	#serializeNode(node) {
		if (!node) return "";
		return this.#serializer.serializeToString(node);
	}

	#serializePretty(node, level = 0) {
		if (!node) return "";
		const indent = "  ".repeat(level);

		// Handle Text Nodes
		if (node.nodeType === 3) {
			const text = node.nodeValue;
			// Only return text if it's not just whitespace
			return text.trim() ? text : "";
		}

		// Handle Document Node
		if (node.nodeType === 9) {
			return this.#serializePretty(node.documentElement, level);
		}

		// Handle Element Nodes
		const tagName = node.tagName;
		let xml = `${indent}<${tagName}`;

		// Add Attributes
		if (node.attributes) {
			for (let i = 0; i < node.attributes.length; i++) {
				const attr = node.attributes[i];
				xml += ` ${attr.name}="${this.#escapeXml(attr.value)}"`;
			}
		}

		// Self-closing if no children
		if (node.childNodes.length === 0) {
			return `${xml}/>\n`;
		}

		// Special handling for content-preserving tags
		const preserve = ["source", "symbols", "persona", "skill", "short", "content", "reasoning_content", "tasks", "known", "unknown"].includes(tagName);

		if (preserve) {
			xml += ">";
			for (let i = 0; i < node.childNodes.length; i++) {
				const child = node.childNodes[i];
				if (child.nodeType === 3) xml += child.nodeValue;
				else xml += this.#serializePretty(child, 0).trim();
			}
			xml += `</${tagName}>\n`;
			return xml;
		}

		// Standard structural tags
		xml += ">\n";
		for (let i = 0; i < node.childNodes.length; i++) {
			const childResult = this.#serializePretty(node.childNodes[i], level + 1);
			if (childResult) xml += childResult;
		}
		xml += `${indent}</${tagName}>\n`;
		return xml;
	}

	#escapeXml(unsafe) {
		return unsafe.replace(/[<>&"']/g, (c) => {
			switch (c) {
				case "<": return "&lt;";
				case ">": return "&gt;";
				case "&": return "&amp;";
				case "\"": return "&quot;";
				case "'": return "&apos;";
			}
			return c;
		});
	}
}
