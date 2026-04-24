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

/**
 * Resolve the competing attr-vs-body philosophies per tool.
 * If the canonical attribute is missing, the body fills it. Silent.
 */
function resolveCommand(name, a, rawBody) {
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
		// Plain write or visibility change
		const body = trimmed || a.body || "";
		return { name, ...a, body };
	}

	if (name === "update") {
		const body = trimmed || a.body || "";
		const status = a.status ? Number(a.status) : 102;
		return { name, ...a, body, status };
	}

	if (name === "get" || name === "rm") {
		// Spread `a` so `line`, `limit`, `visibility`, and future attrs
		// reach the handler. Earlier narrow extraction silently dropped
		// `line=/limit=` and stranded the partial-read path advertised
		// in getDoc.
		return { name, ...a, path: a.path || trimmed || null };
	}

	if (name === "search") {
		const path = a.path || trimmed || null;
		const results = a.results ? Number(a.results) : null;
		return { name, ...a, path, results };
	}

	if (name === "mv" || name === "cp") {
		// Spread `a` so `visibility` reaches the handler. mvDoc
		// advertises `<mv path="known://..." visibility="summarized"/>`
		// for batch visibility changes and was silently stripping that
		// attr before.
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
	/**
	 * Parse tool commands from model content using htmlparser2.
	 * Handles malformed XML gracefully — unclosed tags, missing slashes, etc.
	 * Every tool can appear as self-closing (attrs only) or with body content.
	 * Competing attr-vs-body philosophies are resolved silently.
	 * @param {string} content - Raw model response text
	 * @returns {{ commands: Array, warnings: string[], unparsed: string }}
	 */
	static MAX_COMMANDS = Number(process.env.RUMMY_MAX_COMMANDS);

	static parse(content) {
		if (!content) return { commands: [], warnings: [], unparsed: "" };

		// Normalize native tool call formats to rummy XML
		const normalized = XmlParser.#normalizeToolCalls(content);

		const commands = [];
		const warnings = [];
		const textChunks = [];

		// Pre-flight: neutralize tool tags inside markdown code spans.
		// Models quote instructions containing `<get/>` etc. — the parser
		// would treat them as real tool calls. Replace the angle brackets
		// inside backtick spans so htmlparser2 ignores them.
		const codeNeutralized = XmlParser.#neutralizeCodeSpans(normalized);

		// Pre-flight: fix mismatched close tags that htmlparser2 silently
		// drops (making our onclosetag recovery code unreachable). Must run
		// before balanceAttrQuotes since the mismatch scan needs clean tags.
		const mismatchFixed = XmlParser.#correctMismatchedCloses(
			codeNeutralized,
			warnings,
		);

		// Pre-flight: balance unclosed attribute quotes that would otherwise
		// cause htmlparser2 to consume the rest of input as a single attribute
		// value, silently dropping every subsequent tool call.
		const balanced = XmlParser.#balanceAttrQuotes(mismatchFixed, warnings);
		let current = null;
		let ended = false;
		let capped = false;

		const parser = new Parser(
			{
				onopentag(name, attrs) {
					if (capped) return;

					if (current) {
						// Empty-body case: current tool opened but got no text
						// content before a new tag. The model likely meant current
						// to self-close but typed it in paired form, or emitted a
						// mismatched close tag that htmlparser2 silently dropped.
						// Close current, open new.
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
							// Nested tag inside a body with content — treat as body
							// text. Tool bodies are opaque: the model writing a plan
							// with <get/> in it, SEARCH/REPLACE in <set>, or XML
							// examples in <known> all need to survive intact. Track
							// nested opens on a stack so matching closes pop off and
							// orphan closes (typos) still trigger recovery.
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
						// Matching nested close — pop stack, keep as text.
						const nested = current.nested;
						if (nested.length > 0 && nested[nested.length - 1] === name) {
							nested.pop();
							current.rawBody += `</${name}>`;
							return;
						}

						// Matching close for outer tool — finalize.
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

						// Orphan close for a known tool (likely typo) — recover.
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

						// Unknown orphan close — text.
						current.rawBody += `</${name}>`;
						return;
					}

					if (isImplied && ALL_TOOLS.has(name)) {
						// Self-closing tag that htmlparser2 auto-closed at top level
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

	/**
	 * Repair a specific malformed-tag pattern: an attribute value opened with
	 * `="` that never closes before the next tag. Without repair, htmlparser2
	 * consumes the rest of input as one giant attribute value and silently
	 * drops every subsequent tool call.
	 *
	 * Pattern matched:  <TAG ... ATTR="text-with-no-quote</NEXT>
	 * Repair:           <TAG ... ATTR="text-with-no-quote"></NEXT>
	 *
	 * Conservative — only triggers when the value contains no quote, no `>`,
	 * and is followed by another tag opening or close. Well-formed input is
	 * untouched.
	 */
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

	/**
	 * Correct mismatched close tags before htmlparser2 sees them.
	 *
	 * htmlparser2 silently drops close tags that don't match the currently
	 * open element (e.g. `<set>body</known>` — `</known>` vanishes). This
	 * makes the explicit mismatch recovery in onclosetag unreachable and
	 * causes all subsequent sibling commands to be absorbed as body text.
	 *
	 * Conservative: only corrects when the mismatch is at the outermost
	 * tool depth (stack.length === 1). Nested mismatches inside body text
	 * are left for htmlparser2 + body opacity to handle normally.
	 */
	/**
	 * Neutralize XML tags inside markdown code spans so the parser
	 * doesn't treat quoted tool names as real commands.
	 * `<get/>` → `&lt;get/&gt;`  (htmlparser2 ignores entities)
	 */
	static #neutralizeCodeSpans(content) {
		return content.replace(/`([^`]*)`/g, (match, inner) => {
			if (!/<\/?[\w]/.test(inner)) return match;
			return `\`${inner.replace(/</g, "&lt;").replace(/>/g, "&gt;")}\``;
		});
	}

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
		// NAME may be namespaced with any of /, :, or . separators
		// (e.g. `rummy.nvim/get`, `rummy:get`) — extract the trailing word
		// sequence as the tool name. Value forms observed in the wild:
		//   key="v" / key:"v" / key:v (unquoted) / key:<|"|>v<|"|> (gemma chat-quotes)
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

		// Catch-all: any remaining <|tool_call> tokens are malformed native
		// attempts (no {} block, missing close, wrong shape entirely). Replace
		// each with an <error> so the model gets feedback on its next turn and
		// learns to switch to XML. Lazy-match up to the next native close, the
		// next XML close tag, or end of input — preserves any trailing valid XML.
		// Error body must NOT contain literal <get>/<set>/etc. — those would
		// re-enter the parser as phantom tool calls. Describe the format in
		// prose instead and point at the tool docs above.
		result = result.replace(
			/<\|tool_call>[\s\S]*?(?:<\|?tool_call\|?>|<\/\w+>|$)/g,
			() =>
				"<error>Native tool call format not supported. Use the XML commands listed above (e.g. a get tag with a path attribute, or a set tag with path and body).</error>",
		);

		// Strip any orphan chat-format quote tokens left after replacement.
		result = result.replace(/<\|"\|>/g, '"');

		// Gemma sometimes leaks OpenAI-harmony channel markers around its
		// real XML output: `<|channel>thought\n<channel|>…<set path=…/>`.
		// These aren't tool calls (handled above), they're role/channel
		// tokens. Strip any remaining `<|name>` / `<name|>` pseudo-tags
		// before the XML parser sees them.
		result = result.replace(/<\|[\w:/-]+>/g, "");
		result = result.replace(/<[\w:/-]+\|>/g, "");

		return result;
	}
}
