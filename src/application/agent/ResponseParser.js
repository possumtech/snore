import TodoParser from "./TodoParser.js";

/**
 * ResponseParser: Focused logic for parsing LLM output and managing DOM nodes.
 */
export default class ResponseParser {
	getNodeText(node) {
		if (!node) return "";
		return node.childNodes?.[0]?.value || "";
	}

	mergePrefill(prefill, content) {
		if (content.startsWith(prefill)) return content;
		if (
			content.startsWith("] ") ||
			content.startsWith("x] ") ||
			content.startsWith(" ] ")
		) {
			return prefill + content;
		}
		// Provider echoed the trailing "- [ ] " but not the checked items
		if (prefill.endsWith("- [ ] ") && content.startsWith("- [ ] ")) {
			return prefill.slice(0, -6) + content;
		}
		if (!content.includes("<todo>")) return prefill + content;
		return content;
	}

	parseTodoList(text) {
		return TodoParser.parse(text);
	}

	parsePromptUser(node) {
		const fullText = this.getNodeText(node);

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
			const label = text.split(/\r?\n|:/)[0].trim();
			return {
				label: label || "Option",
				description: text,
			};
		});

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
			"summary",
			"todo",
			"info",
			"known",
			"unknown",
		];

		const tags = [];
		const seenKeys = new Set();

		const addTag = (name, text, attrs = [], index = 0) => {
			const attrKey = attrs.map((a) => `${a.name}=${a.value}`).join(",");
			const key = `${name}:${text.substring(0, 50)}:${attrKey}`;
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

		for (const name of coreTagNames) {
			// Self-closing: <name attr="val"/>
			const selfClosingRegex = new RegExp(`<${name}([^>]*?)/>`, "gi");
			for (const match of content.matchAll(selfClosingRegex)) {
				addTag(name, "", this.#parseAttrs(match[1]), match.index);
			}

			// Standard: <name attr="val">content</name>
			const standardRegex = new RegExp(
				`<${name}([^/>]*)>(?:([\\s\\S]*?)</${name}>|([\\s\\S]*?)(?=<[a-z])|$)`,
				"gi",
			);
			const standardMatches = Array.from(content.matchAll(standardRegex));
			for (const match of standardMatches) {
				const attrString = match[1];
				const tagContent = match[2] || match[3] || "";
				addTag(name, tagContent, this.#parseAttrs(attrString), match.index);
			}

			const unclosedRegex = new RegExp(
				`<${name}([^>]*?)(?:/|(?=\\s|$))$`,
				"gi",
			);
			for (const match of content.matchAll(unclosedRegex)) {
				const attrString = match[1];
				addTag(name, "", this.#parseAttrs(attrString), match.index);
			}

			if (standardMatches.length === 0) {
				const trailingRegex = new RegExp(
					`(?:</${name}>|\\b${name}/?>)([\\s\\S]*?)$`,
					"gi",
				);
				for (const match of content.matchAll(trailingRegex)) {
					const tagContent = match[1] || "";
					addTag(name, tagContent, [], match.index);
				}
			}
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
