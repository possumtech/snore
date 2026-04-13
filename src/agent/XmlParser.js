import { Parser } from "htmlparser2";
import { parseEditContent } from "../plugins/hedberg/edits.js";
import { normalizeAttrs, parseJsonEdit } from "../plugins/hedberg/normalize.js";
import { parseSed } from "../plugins/hedberg/sed.js";

const STORE_TOOLS = new Set(["get", "rm", "set", "mv", "cp", "search"]);
export const ALL_TOOLS = new Set([
	...STORE_TOOLS,
	"known",
	"sh",
	"env",
	"ask_user",
	"summarize",
	"update",
	"unknown",
	"think",
]);

/**
 * Resolve the competing attr-vs-body philosophies per tool.
 * If the canonical attribute is missing, the body fills it. Silent.
 */
function resolveCommand(name, attrs, rawBody) {
	const a = normalizeAttrs(attrs);
	const trimmed = rawBody.trim();

	if (name === "set") {
		// Structured edit detection — merge conflict, udiff, Claude XML
		const hasEdit =
			/<{3,12} SEARCH/.test(trimmed) ||
			/>{3,12} REPLACE/.test(trimmed) ||
			(trimmed.includes("@@") &&
				(trimmed.includes("\n-") || trimmed.includes("\n+"))) ||
			trimmed.includes("<old_text>");
		if (hasEdit) {
			const blocks = parseEditContent(rawBody);
			if (blocks.length > 0) {
				return {
					name,
					path: a.path,
					body: a.body,
					preview: a.preview,
					blocks,
				};
			}
		}
		// JSON-style { search, replace }
		const jsonEdit = parseJsonEdit(trimmed);
		if (jsonEdit) {
			return { name, path: a.path, ...jsonEdit };
		}
		// Sed syntax: s/search/replace/flags — supports chained commands
		if (trimmed.startsWith("s/")) {
			const blocks = parseSed(trimmed);
			if (blocks?.length === 1) {
				return {
					name,
					path: a.path,
					search: blocks[0].search,
					replace: blocks[0].replace,
					flags: blocks[0].flags,
					sed: true,
				};
			}
			if (blocks?.length > 1) {
				return { name, path: a.path, blocks };
			}
		}
		// search+replace attrs → attribute edit mode
		if (a.search) {
			const replace = a.replace ?? trimmed;
			return {
				name,
				path: a.path,
				body: a.body,
				preview: a.preview,
				search: a.search,
				replace,
			};
		}
		// Body attr + body content → search/replace (attr is search, body is replace)
		if (trimmed && a.body) {
			return {
				name,
				path: a.path,
				search: a.body,
				replace: trimmed,
				preview: a.preview,
			};
		}
		// Plain write or fidelity change
		const body = trimmed || a.body || "";
		return { name, ...a, body };
	}

	if (name === "summarize" || name === "update" || name === "unknown") {
		const body = trimmed || a.body || "";
		return { name, body };
	}

	if (name === "known") {
		const body = trimmed || a.body || "";
		const path = a.path || null;
		return { name, ...a, path, body };
	}

	if (name === "get" || name === "rm") {
		const path = a.path || trimmed || null;
		return { name, path, body: a.body, preview: a.preview };
	}

	if (name === "search") {
		const path = a.path || trimmed || null;
		const results = a.results ? Number(a.results) : null;
		return { name, path, results };
	}

	if (name === "mv" || name === "cp") {
		const to = a.to || trimmed || null;
		return { name, path: a.path, to };
	}

	if (name === "sh" || name === "env") {
		const command = a.command || trimmed || null;
		return { name, command };
	}

	if (name === "ask_user") {
		const question = a.question || null;
		const options = a.options || trimmed || null;
		return { name, question, options };
	}

	return { name, ...a, body: trimmed || a.body };
}

export default class XmlParser {
	/**
	 * Parse tool commands from model content using htmlparser2.
	 * Handles malformed XML gracefully — unclosed tags, missing slashes, etc.
	 * Every tool can appear as self-closing (attrs only) or with body content.
	 * Competing attr-vs-body philosophies are resolved silently.
	 * @param {string} content - Raw model response text
	 * @returns {{ commands: Array, warnings: string[], unparsed: string }}
	 */
	static MAX_COMMANDS = Number(process.env.RUMMY_MAX_COMMANDS) || 99;

	static parse(content) {
		if (!content) return { commands: [], warnings: [], unparsed: "" };

		// Normalize native tool call formats to rummy XML
		const normalized = XmlParser.#normalizeToolCalls(content);

		const commands = [];
		const warnings = [];
		const textChunks = [];
		let current = null;
		let ended = false;
		let capped = false;

		const parser = new Parser(
			{
				onopentag(name, attrs) {
					if (capped) return;
					if (!ALL_TOOLS.has(name)) {
						if (current) {
							const attrStr = Object.entries(attrs)
								.map(([k, v]) => (v === "" ? k : `${k}="${v}"`))
								.join(" ");
							current.rawBody += attrStr ? `<${name} ${attrStr}>` : `<${name}>`;
						}
						return;
					}

					// Known tool opened while another is still open — close the old one.
					if (current) {
						warnings.push(
							`Unclosed <${current.name}> before <${name}> — recovered`,
						);
						commands.push(
							resolveCommand(current.name, current.attrs, current.rawBody),
						);
					}

					if (commands.length >= XmlParser.MAX_COMMANDS) {
						capped = true;
						current = null;
						return;
					}

					current = { name, attrs, rawBody: "" };
				},

				ontext(text) {
					if (capped) return;
					if (current) {
						current.rawBody += text;
					} else {
						textChunks.push(text);
					}
				},

				onclosetag(name, isImplied) {
					if (capped) return;
					if (current && name === current.name) {
						if (ended) {
							warnings.push(`Unclosed <${name}> tag — content captured anyway`);
						}
						commands.push(
							resolveCommand(current.name, current.attrs, current.rawBody),
						);
						current = null;
					} else if (current && ALL_TOOLS.has(name)) {
						// Mismatched close tag for a known tool — close current tag,
						// don't swallow subsequent commands as body text.
						warnings.push(
							`Mismatched </${name}> closing <${current.name}> — recovered`,
						);
						commands.push(
							resolveCommand(current.name, current.attrs, current.rawBody),
						);
						current = null;
					} else if (current) {
						current.rawBody += `</${name}>`;
					} else if (isImplied && ALL_TOOLS.has(name)) {
						// Self-closing tag that htmlparser2 auto-closed
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

		parser.write(normalized);
		ended = true;
		parser.end();

		// Flush any unclosed tool tag
		if (current && !capped) {
			warnings.push(`Unclosed <${current.name}> tag — content captured anyway`);
			commands.push(
				resolveCommand(current.name, current.attrs, current.rawBody),
			);
			current = null;
		}

		if (capped) {
			warnings.push(
				`Tool call limit (${XmlParser.MAX_COMMANDS}) reached — remaining commands dropped`,
			);
		}

		const unparsed = textChunks.join("").trim();
		return { commands, warnings, unparsed };
	}

	/**
	 * Normalize native tool call formats to rummy XML.
	 * Models sometimes emit their training-format tool calls instead of
	 * our XML tags. The intent is unambiguous — translate silently.
	 */
	static #normalizeToolCalls(content) {
		// Gemma: ```tool_code\n<xml>...\n``` — strip code fences around valid XML
		let result = content.replace(
			/```(?:tool_code|tool_command|xml)\n([\s\S]*?)```/g,
			(_, inner) => inner.trim(),
		);

		// Qwen/gemma: <|tool_call>call:NAME{key:"value"}<tool_call|>
		result = result.replace(
			/<\|tool_call>call:(\w+)\{([^}]*)\}<(?:tool_call\||\|tool_call)>/g,
			(_, name, params) => {
				if (!ALL_TOOLS.has(name)) return _;
				const valueMatch = params.match(/["']([^"']+)["']/);
				const body = valueMatch?.[1] || "";
				return `<${name}>${body}</${name}>`;
			},
		);

		// OpenAI function_call JSON: {"name":"search","arguments":{"query":"..."}}
		result = result.replace(
			/\{"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*\{([^}]*)\}\}/g,
			(_, name, args) => {
				if (!ALL_TOOLS.has(name)) return _;
				const pairs = [...args.matchAll(/"(\w+)"\s*:\s*"([^"]*)"/g)];
				const body = pairs[0]?.[2] || "";
				return `<${name}>${body}</${name}>`;
			},
		);

		// Anthropic: <tool_use><name>search</name><input>{"query":"..."}</input></tool_use>
		result = result.replace(
			/<tool_use>\s*<name>(\w+)<\/name>\s*<input>\{([^}]*)\}<\/input>\s*<\/tool_use>/g,
			(_, name, args) => {
				if (!ALL_TOOLS.has(name)) return _;
				const pairs = [...args.matchAll(/"(\w+)"\s*:\s*"([^"]*)"/g)];
				const body = pairs[0]?.[2] || "";
				return `<${name}>${body}</${name}>`;
			},
		);

		// Mistral: [TOOL_CALLS] [{"name":"search","arguments":{"query":"..."}}]
		result = result.replace(
			/\[TOOL_CALLS\]\s*\[\{"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*\{([^}]*)\}\}\]/g,
			(_, name, args) => {
				if (!ALL_TOOLS.has(name)) return _;
				const pairs = [...args.matchAll(/"(\w+)"\s*:\s*"([^"]*)"/g)];
				const body = pairs[0]?.[2] || "";
				return `<${name}>${body}</${name}>`;
			},
		);

		return result;
	}
}
