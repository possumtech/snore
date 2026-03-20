import * as parse5 from "parse5";

/**
 * ResponseParser: Focused logic for parsing LLM output and managing DOM nodes.
 */
export default class ResponseParser {
	getNodeText(node) {
		if (!node) return "";
		// Handle our mock regex nodes from Greedy Resilience
		if (node.isMock) {
			return node.childNodes?.[0]?.value || "";
		}
		const html = parse5.serialize(node);
		return html
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&")
			.replace(/&quot;/g, '"');
	}

	mergePrefill(prefill, content) {
		if (content.startsWith(prefill)) {
			return content;
		}
		if (
			content.startsWith("] ") ||
			content.startsWith("x] ") ||
			content.startsWith(" ] ")
		) {
			return prefill + content;
		}
		if (!content.includes("<tasks>")) {
			return prefill + content;
		}
		return content;
	}

	appendAssistantContent(turnObj, tagName, content) {
		const doc = turnObj.doc;
		const assistantEl = doc.getElementsByTagName("assistant")[0];
		let targetEl = assistantEl.getElementsByTagName(tagName)[0];
		if (!targetEl) {
			targetEl = doc.createElement(tagName);
			assistantEl.appendChild(targetEl);
		}

		const frag = parse5.parseFragment(content);
		this.convertToXmlDom(doc, targetEl, frag);
	}

	convertToXmlDom(doc, target, p5Node) {
		if (p5Node.nodeName === "#text") {
			target.appendChild(doc.createTextNode(p5Node.value));
		} else if (p5Node.tagName) {
			const el = doc.createElement(p5Node.tagName);
			if (p5Node.attrs) {
				for (const attr of p5Node.attrs) {
					el.setAttribute(attr.name, attr.value);
				}
			}
			target.appendChild(el);
			if (p5Node.childNodes) {
				for (const child of p5Node.childNodes) {
					this.convertToXmlDom(doc, el, child);
				}
			}
		} else if (p5Node.childNodes) {
			for (const child of p5Node.childNodes) {
				this.convertToXmlDom(doc, target, child);
			}
		}
	}

	parsePromptUser(node) {
		const fullText = this.getNodeText(node);

		// Split by the first occurrence of the checklist marker
		const marker = "- [ ]";
		const firstIndex = fullText.indexOf(marker);

		if (firstIndex === -1) {
			return {
				question: fullText.trim(),
				options: [
					{
						label: "Other",
						description: "None of the above. Provide a freeform answer.",
					},
				],
			};
		}

		const question =
			fullText.substring(0, firstIndex).trim() || "The agent has a question:";
		const rawOptions = fullText
			.substring(firstIndex)
			.split(marker)
			.filter(Boolean);

		const options = rawOptions.map((opt) => {
			const text = opt.trim();
			// Extract a label from the first line or first segment
			const label = text.split(/\r?\n|:/)[0].trim();
			return {
				label: label || "Option",
				description: text,
			};
		});

		// Always append the "Other" option
		options.push({
			label: "Other",
			description: "None of the above. Provide a freeform answer.",
		});

		return { question, options };
	}

	parseActionTags(content) {
		const coreTagNames = [
			"read",
			"drop",
			"env",
			"run",
			"create",
			"delete",
			"edit",
			"prompt_user",
			"remark",
			"summary",
			"tasks",
			"analysis",
			"info",
			"known",
			"unknown",
		];

		const tags = [];
		const seenKeys = new Set();

		// Helper to add unique tags
		const addTag = (name, text, attrs = [], index = 0) => {
			const key = `${name}:${text.substring(0, 20)}:${index}`;
			if (seenKeys.has(key)) return;
			seenKeys.add(key);

			tags.push({
				tagName: name,
				isMock: true,
				attrs: attrs || [],
				childNodes: [{ nodeName: "#text", value: text.trim() }],
				startIndex: index,
			});
		};

		// 1. Aggressive Regex Extraction (The "Greedy" layer)
		// This catches mangled tags like <read file="a.js" <read file="b.js">
		for (const name of coreTagNames) {
			const regex = new RegExp(
				`<${name}([^>]*)>([\\s\\S]*?)(?:</${name}>|(?=<[a-z])|$)`,
				"gi",
			);
			for (const match of content.matchAll(regex)) {
				const attrString = match[1];
				const tagContent = match[2];
				addTag(name, tagContent, this.#parseAttrs(attrString), match.index);
			}
		}

		// 2. DOM Parsing (The "Structural" layer)
		try {
			const frag = parse5.parseFragment(content);
			const traverse = (node) => {
				if (node.tagName && coreTagNames.includes(node.tagName)) {
					const text = this.getNodeText(node);
					const attrs =
						node.attrs?.map((a) => ({ name: a.name, value: a.value })) || [];
					addTag(node.tagName, text, attrs, content.indexOf(node.tagName));
				}
				if (node.childNodes) {
					for (const child of node.childNodes) traverse(child);
				}
			};
			traverse(frag);
		} catch (_err) {
			// DOM failed, regex layer already has data
		}

		return tags.sort((a, b) => a.startIndex - b.startIndex);
	}

	#parseAttrs(tagString) {
		const attrs = [];
		if (!tagString) return attrs;
		const attrRegex = /([a-z-]+)="([^"]*)"/gi;
		for (const match of tagString.matchAll(attrRegex)) {
			attrs.push({ name: match[1], value: match[2] });
		}
		return attrs;
	}
}
