import * as parse5 from "parse5";

/**
 * ResponseParser: Focused logic for parsing LLM output and managing DOM nodes.
 */
export default class ResponseParser {
	getNodeText(node) {
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
					{ label: "Other", description: "None of the above. Provide a freeform answer." }
				]
			};
		}

		const question = fullText.substring(0, firstIndex).trim() || "The agent has a question:";
		const rawOptions = fullText.substring(firstIndex).split(marker).filter(Boolean);

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
		const frag = parse5.parseFragment(content);
		const tags = [];
		const traverse = (node) => {
			if (
				node.tagName &&
				[
					"read",
					"env",
					"run",
					"create",
					"delete",
					"edit",
					"prompt_user",
					"summary",
					"tasks",
					"analysis",
					"info",
				].includes(node.tagName)
			) {
				tags.push(node);
			}
			if (node.childNodes) {
				for (const child of node.childNodes) {
					traverse(child);
				}
			}
		};
		traverse(frag);
		return tags;
	}
}
