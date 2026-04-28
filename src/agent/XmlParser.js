import { Parser } from "htmlparser2";
import { parseEditContent } from "../plugins/hedberg/edits.js";
import { parseJsonEdit } from "../plugins/hedberg/normalize.js";
import { parseSed } from "../plugins/hedberg/sed.js";

const STORE_TOOLS = new Set(["get", "rm", "set", "mv", "cp", "search"]);
export const ALL_TOOLS = new Set([
	...STORE_TOOLS,
	"sh",
	"env",
	"ask_user",
	"update",
	"think",
]);

// Per-tool resolution: missing canonical attribute is filled silently from the body.
function resolveCommand(name, a, rawBody) {
	const trimmed = rawBody.trim();

	if (name === "set") {
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
					manifest: a.manifest,
					blocks,
				};
			}
		}
		const jsonEdit = parseJsonEdit(trimmed);
		if (jsonEdit) {
			return { name, path: a.path, ...jsonEdit };
		}
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
		if (a.search) {
			const replace = a.replace ?? trimmed;
			return {
				name,
				path: a.path,
				body: a.body,
				manifest: a.manifest,
				search: a.search,
				replace,
			};
		}
		if (trimmed && a.body) {
			return {
				name,
				path: a.path,
				search: a.body,
				replace: trimmed,
				manifest: a.manifest,
			};
		}
		const body = trimmed || a.body || "";
		return { name, ...a, body };
	}

	if (name === "update") {
		const body = trimmed || a.body || "";
		const status = a.status ? Number(a.status) : 102;
		return { name, ...a, body, status };
	}

	if (name === "get" || name === "rm") {
		return { name, ...a, path: a.path || trimmed || null };
	}

	if (name === "search") {
		const path = a.path || trimmed || null;
		const results = a.results ? Number(a.results) : null;
		return { name, ...a, path, results };
	}

	if (name === "mv" || name === "cp") {
		return { name, ...a, path: a.path, to: a.to || trimmed || null };
	}

	if (name === "sh" || name === "env") {
		const command = a.command || trimmed || null;
		return { name, ...a, command };
	}

	if (name === "ask_user") {
		const question = a.question || null;
		const options = a.options || trimmed || null;
		return { name, ...a, question, options };
	}

	return { name, ...a, body: trimmed || a.body };
}

export default class XmlParser {
	static MAX_COMMANDS = Number(process.env.RUMMY_MAX_COMMANDS);

	static parse(content) {
		if (!content) return { commands: [], warnings: [], unparsed: "" };

		const normalized = XmlParser.#normalizeToolCalls(content);

		const commands = [];
		const warnings = [];
		const textChunks = [];

		const codeNeutralized = XmlParser.#neutralizeCodeSpans(normalized);
		// Mismatch fix must precede attr-quote balance (needs clean tags).
		const mismatchFixed = XmlParser.#correctMismatchedCloses(
			codeNeutralized,
			warnings,
		);
		const balanced = XmlParser.#balanceAttrQuotes(mismatchFixed, warnings);
		let current = null;
		let ended = false;
		let capped = false;

		const parser = new Parser(
			{
				onopentag(name, attrs) {
					if (capped) return;

					if (current) {
						// Empty-body before new open: treat as unclosed prior tool.
						const hasBody = current.rawBody.trim() !== "";
						const hasNestedOpens = (current.nested || []).length > 0;
						if (!hasBody && !hasNestedOpens && ALL_TOOLS.has(name)) {
							warnings.push(
								`Unclosed <${current.name}> before <${name}> — recovered`,
							);
							commands.push(
								resolveCommand(current.name, current.attrs, current.rawBody),
							);
							current = null;
						} else {
							// Body opacity: stack the nested open; see SPEC #xml_parser.
							const attrStr = Object.entries(attrs)
								.map(([k, v]) => (v === "" ? k : `${k}="${v}"`))
								.join(" ");
							current.rawBody += attrStr ? `<${name} ${attrStr}>` : `<${name}>`;
							current.nested ||= [];
							current.nested.push(name);
							return;
						}
					}

					if (!ALL_TOOLS.has(name)) return;

					if (commands.length >= XmlParser.MAX_COMMANDS) {
						capped = true;
						return;
					}

					current = { name, attrs, rawBody: "", nested: [] };
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

					if (current) {
						const nested = current.nested;
						if (nested.length > 0 && nested[nested.length - 1] === name) {
							nested.pop();
							current.rawBody += `</${name}>`;
							return;
						}

						if (name === current.name && nested.length === 0) {
							if (ended) {
								warnings.push(
									`Unclosed <${name}> tag — content captured anyway`,
								);
							}
							commands.push(
								resolveCommand(current.name, current.attrs, current.rawBody),
							);
							current = null;
							return;
						}

						// Orphan close of a known tool — likely typo; recover.
						if (ALL_TOOLS.has(name)) {
							warnings.push(
								`Mismatched </${name}> closing <${current.name}> — recovered`,
							);
							commands.push(
								resolveCommand(current.name, current.attrs, current.rawBody),
							);
							current = null;
							return;
						}

						current.rawBody += `</${name}>`;
						return;
					}

					if (isImplied && ALL_TOOLS.has(name)) {
						// no-op: htmlparser2 auto-closed a top-level self-closer
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

		parser.write(balanced);
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

	// Close ATTR=" values that never quote-close before the next tag.
	static #balanceAttrQuotes(content, warnings) {
		let fixes = 0;
		const repaired = content.replace(
			/(<\w+\s[^<>]*?\w+=")([^"<>]*?)(<\/?\w+)/g,
			(_, opening, value, nextTag) => {
				fixes++;
				return `${opening}${value}">${nextTag}`;
			},
		);
		if (fixes > 0) {
			warnings.push(
				`Repaired ${fixes} malformed attribute(s) — close all attribute values with a quote.`,
			);
		}
		return repaired;
	}

	// Entity-encode tag brackets inside backtick spans so quoted tool names don't parse.
	static #neutralizeCodeSpans(content) {
		return content.replace(/`([^`]*)`/g, (match, inner) => {
			if (!/<\/?[\w]/.test(inner)) return match;
			return `\`${inner.replace(/</g, "&lt;").replace(/>/g, "&gt;")}\``;
		});
	}

	// Rewrite outer-depth mismatched close tags before htmlparser2 silently drops them.
	static #correctMismatchedCloses(content, warnings) {
		const stack = [];
		return content.replace(
			/<(\/?)(\w+)([^>]*?)(\/?)>/g,
			(match, slash, tag, _attrs, selfClose) => {
				if (!ALL_TOOLS.has(tag)) return match;
				if (selfClose === "/") return match;
				if (slash === "/") {
					if (stack.length === 0) return match;
					if (stack[stack.length - 1] === tag) {
						stack.pop();
						return match;
					}
					if (stack.length === 1) {
						const top = stack.pop();
						warnings.push(
							`Mismatched </${tag}> closing <${top}> — corrected to </${top}>`,
						);
						return `</${top}>`;
					}
					return match;
				}
				stack.push(tag);
				return match;
			},
		);
	}

	// Translate native training-format tool calls into rummy XML silently.
	static #normalizeToolCalls(content) {
		// Gemma code-fenced XML.
		let result = content.replace(
			/```(?:tool_code|tool_command|xml)\n([\s\S]*?)```/g,
			(_, inner) => inner.trim(),
		);

		// Qwen/gemma <|tool_call>call:NAME{...}<tool_call|>; NAME may be namespaced.
		result = result.replace(
			/<\|tool_call>call:([\w.:/-]+)\{([^}]*)\}<(?:tool_call\||\|tool_call)>/g,
			(match, qualifiedName, params) => {
				const name = qualifiedName.match(/\w+$/)?.[0] ?? qualifiedName;
				if (!ALL_TOOLS.has(name)) {
					return `<error>Unknown command '${qualifiedName}' in <|tool_call> format. Use XML commands listed above.</error>`;
				}
				const valueMatch = params.match(
					/[=:]\s*(?:<\|"\|>([^<]*?)<\|"\|>|"([^"]*)"|'([^']*)'|([^,}]+))/,
				);
				const body = (
					valueMatch?.[1] ??
					valueMatch?.[2] ??
					valueMatch?.[3] ??
					valueMatch?.[4] ??
					""
				).trim();
				if (!body) {
					return `<error>Could not extract argument from <|tool_call> ${match}. Use XML format like <${name}>value</${name}>.</error>`;
				}
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

		// Catch-all malformed <|tool_call> → <error> in prose (no literal tags or they'd re-parse).
		result = result.replace(
			/<\|tool_call>[\s\S]*?(?:<\|?tool_call\|?>|<\/\w+>|$)/g,
			() =>
				"<error>Native tool call format not supported. Use the XML commands listed above (e.g. a get tag with a path attribute, or a set tag with path and body).</error>",
		);

		result = result.replace(/<\|"\|>/g, '"');

		// Strip OpenAI-harmony role/channel pseudo-tags (gemma leaks these).
		result = result.replace(/<\|[\w:/-]+>/g, "");
		result = result.replace(/<[\w:/-]+\|>/g, "");

		return result;
	}
}
