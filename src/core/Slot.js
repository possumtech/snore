/**
 * A Slot is a priority-ordered collection of content fragments.
 */
export default class Slot {
	#fragments = [];

	add(content, priority = 10, key = null) {
		this.#fragments.push({ content, priority, key });
		this.#fragments.sort((a, b) => a.priority - b.priority);
	}

	get fragments() {
		return [...this.#fragments];
	}

	get hasContent() {
		if (this.#fragments.length === 0) return false;
		return this.toString().trim().length > 0;
	}

	toString() {
		return this.#fragments
			.map((f) =>
				typeof f.content === "string"
					? f.content
					: JSON.stringify(f.content, null, 2),
			)
			.filter(Boolean)
			.join("\n");
	}

	/**
	 * Specialized serializer for file objects
	 */
	serializeFiles(indentStr = "") {
		if (this.#fragments.length === 0) return "";

		const innerIndent = `${indentStr}\t`;
		const xml = this.#fragments
			.map((f) => {
				const file = f.content;
				const status = file.status || file.mode || "unknown";

				const hasSymbols =
					Array.isArray(file.symbols) && file.symbols.length > 0;
				const hasContent =
					typeof file.content === "string" && file.content.length > 0;

				if (!hasSymbols && !hasContent) {
					return `${innerIndent}<file path="${file.path}" status="${status}" />`;
				}

				const parts = [
					`${innerIndent}<file path="${file.path}" status="${status}">`,
				];

				if (hasSymbols) {
					parts.push(`${innerIndent}\t<symbols>`);
					const json = JSON.stringify(file.symbols, null, 2);
					const indentedJson = json
						.split("\n")
						.map((line) => `${innerIndent}\t\t${line}`)
						.join("\n");
					parts.push(indentedJson);
					parts.push(`${innerIndent}\t</symbols>`);
				}

				if (hasContent) {
					const indentedContent = file.content
						.split("\n")
						.map((line) => `${innerIndent}\t${line}`)
						.join("\n");
					parts.push(indentedContent);
				}

				parts.push(`${innerIndent}</file>`);
				return parts.join("\n");
			})
			.join("\n");

		return xml ? `${indentStr}<files>\n${xml}\n${indentStr}</files>` : "";
	}
}
