import { Parser } from "htmlparser2";

const SELF_CLOSING_TOOLS = new Set([
	"read",
	"drop",
	"delete",
	"run",
	"env",
	"ask_user",
]);
const CONTENT_TOOLS = new Set(["summary", "unknown", "known", "edit"]);
const ALL_TOOLS = new Set([...SELF_CLOSING_TOOLS, ...CONTENT_TOOLS]);

function parseEditContent(content) {
	const blocks = [];
	const re =
		/<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
	const replaceOnly = /^=======\n([\s\S]*?)\n>>>>>>> REPLACE/gm;

	for (const m of content.matchAll(re)) {
		blocks.push({ search: m[1], replace: m[2] });
	}

	if (blocks.length === 0) {
		for (const m of content.matchAll(replaceOnly)) {
			blocks.push({ search: null, replace: m[1] });
		}
	}

	return blocks;
}

export default class XmlParser {
	/**
	 * Parse tool commands from model content using htmlparser2.
	 * Handles malformed XML gracefully — unclosed tags, missing slashes, etc.
	 * @param {string} content - Raw model response text
	 * @returns {{ commands: Array, warnings: string[], unparsed: string }}
	 */
	static parse(content) {
		if (!content) return { commands: [], warnings: [], unparsed: "" };

		const commands = [];
		const warnings = [];
		const textChunks = [];
		let current = null;
		let ended = false;

		const parser = new Parser(
			{
				onopentag(name, attrs) {
					if (!ALL_TOOLS.has(name)) {
						if (current) {
							// Nested unknown tag inside a content tool — treat as text
							current.body += `<${name}>`;
						}
						return;
					}

					if (SELF_CLOSING_TOOLS.has(name)) {
						commands.push({ name, ...attrs });
						return;
					}

					// Content tool — start collecting body
					current = { name, attrs, body: "" };
				},

				ontext(text) {
					if (current) {
						current.body += text;
					} else {
						textChunks.push(text);
					}
				},

				onclosetag(name) {
					if (current && name === current.name) {
						if (ended) {
							warnings.push(`Unclosed <${name}> tag — content captured anyway`);
						}
						const { name: toolName, attrs, body } = current;

						if (toolName === "edit") {
							const blocks = parseEditContent(body);
							commands.push({ name: toolName, file: attrs.file, blocks });
						} else if (toolName === "known") {
							commands.push({
								name: toolName,
								key: attrs.key,
								value: body.trim(),
							});
						} else {
							commands.push({ name: toolName, value: body.trim(), ...attrs });
						}

						current = null;
					} else if (current) {
						// Closing tag for something else while inside a content tool — treat as text
						current.body += `</${name}>`;
					}
				},

				onerror(err) {
					warnings.push(`Parse error: ${err.message}`);
				},
			},
			{
				recognizeSelfClosing: true,
				lowerCaseTags: true,
				lowerCaseAttributeNames: true,
			},
		);

		parser.write(content);
		ended = true;
		parser.end();

		const unparsed = textChunks.join("").trim();
		return { commands, warnings, unparsed };
	}
}
