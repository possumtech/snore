import { parseEditContent } from "../plugins/hedberg/edits.js";
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
		// search/replace as attributes was an edit shape that nothing in
		// the protocol now teaches; strip them so they can't sneak past
		// via the attribute spread.
		const { search: _s, replace: _r, ...rest } = a;
		a = rest;

		// Self-close / no-body: visibility/metadata op.
		if (!trimmed) return { name, ...a, body: a.body || "" };

		// Sed shorthand: `s/old/new/` (single block) or chained.
		if (trimmed.startsWith("s/")) {
			const blocks = parseSed(trimmed);
			if (blocks?.length === 1) {
				return {
					name,
					...a,
					search: blocks[0].search,
					replace: blocks[0].replace,
					flags: blocks[0].flags,
					sed: true,
				};
			}
			if (blocks?.length > 1) {
				return { name, ...a, blocks };
			}
		}

		// SEARCH/REPLACE blocks (edit existing content; empty SEARCH = create).
		const blocks = parseEditContent(rawBody);
		if (blocks.length > 0) {
			return { name, ...a, blocks };
		}

		// Raw body — direct create / overwrite. The most common shape for
		// short scheme entries (unknown://, known://) and any deliverable
		// where the model isn't editing pre-existing content.
		return { name, ...a, body: trimmed };
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

const NAME_CHAR = /[a-zA-Z0-9_]/;
const ATTR_KEY_CHAR = /[a-zA-Z0-9_:-]/;
const WS = /\s/;

// Tokenizer for rummy's closed set of tool tags. Strict body opacity, no
// silent recovery on orphan closes.
//
// Design contract:
//   - Tool tags (<get>, <set>, <sh>, ...) are the only syntactic special tags.
//     Any other "<...>" sequence in OUTER text is treated as literal text.
//   - Inside a tool tag's body, content is OPAQUE: only the matching
//     `</tagname>` close (depth-counted for same-name nesting) ends the
//     body. Mismatched closes of OTHER tag names — `</env>`, `</mv>`,
//     `</foo>` inside a `<set>` body — are body content, not structural
//     signals.
//   - Backtick spans (`...`) and triple-backtick fences (```...```)
//     suppress tag recognition both at OUTER level AND inside tool
//     bodies. This is what lets a model write markdown documentation
//     about rummy commands inside a `<set>` body without the backticked
//     examples breaking the body's opacity.
//   - Same-name nesting (`<set>...<set/>...</set>`) is depth-counted so
//     nested examples don't prematurely close the outer.
//   - Unclosed openers capture body to EOF and emit a clear "Unclosed"
//     warning. The model sees the failure and corrects on the next turn.
export default class XmlParser {
	static MAX_COMMANDS = Number(process.env.RUMMY_MAX_COMMANDS);

	static parse(content) {
		if (!content) return { commands: [], warnings: [], unparsed: "" };

		const normalized = XmlParser.#normalizeToolCalls(content);
		return XmlParser.#tokenize(normalized, []);
	}

	static #tokenize(s, warnings) {
		const commands = [];
		const text = [];
		let i = 0;
		let inSingleBacktick = false;
		let inTripleFence = false;
		let capped = false;

		while (i < s.length) {
			if (commands.length >= XmlParser.MAX_COMMANDS) {
				capped = true;
				break;
			}

			// Triple-backtick fence toggles take precedence over single backtick
			// because ``` overlaps `.
			if (s[i] === "`" && s[i + 1] === "`" && s[i + 2] === "`") {
				inTripleFence = !inTripleFence;
				text.push("```");
				i += 3;
				continue;
			}
			if (s[i] === "`" && !inTripleFence) {
				inSingleBacktick = !inSingleBacktick;
				text.push("`");
				i++;
				continue;
			}

			if (inSingleBacktick || inTripleFence || s[i] !== "<") {
				text.push(s[i]);
				i++;
				continue;
			}

			const opener = XmlParser.#matchOpener(s, i);
			if (!opener) {
				text.push(s[i]);
				i++;
				continue;
			}

			const { name, attrs, selfClose, end: openerEnd } = opener;

			if (selfClose) {
				commands.push(resolveCommand(name, attrs, ""));
				i = openerEnd;
				continue;
			}

			const result = XmlParser.#findBodyEnd(s, name, openerEnd);
			const body = s.slice(openerEnd, result.bodyEnd);
			if (result.unclosed) {
				warnings.push(`Unclosed <${name}> tag — content captured anyway`);
			}
			commands.push(resolveCommand(name, attrs, body));
			i = result.afterClose;

			// Body terminated; reset outer-text fence tracking.
			inSingleBacktick = false;
			inTripleFence = false;
		}

		if (capped) {
			warnings.push(
				`Tool call limit (${XmlParser.MAX_COMMANDS}) reached — remaining commands dropped`,
			);
		}

		return {
			commands,
			warnings,
			unparsed: text.join("").trim(),
		};
	}

	// Returns { name, attrs, selfClose, end } if `s[pos..]` opens a known tool,
	// else null. `end` is the index after the closing `>` (or `/>`).
	static #matchOpener(s, pos) {
		if (s[pos] !== "<") return null;
		let i = pos + 1;

		const nameStart = i;
		while (i < s.length && NAME_CHAR.test(s[i])) i++;
		const name = s.slice(nameStart, i).toLowerCase();
		if (!ALL_TOOLS.has(name)) return null;

		// Char after the name must end the name token cleanly.
		if (i < s.length && !WS.test(s[i]) && s[i] !== "/" && s[i] !== ">") {
			return null;
		}

		const attrsStart = i;
		let inQuote = null;

		while (i < s.length) {
			const c = s[i];
			if (inQuote) {
				if (c === inQuote) inQuote = null;
				i++;
				continue;
			}
			if (c === '"' || c === "'") {
				inQuote = c;
				i++;
				continue;
			}
			if (c === "/") {
				let k = i + 1;
				while (k < s.length && WS.test(s[k])) k++;
				if (s[k] === ">") {
					return {
						name,
						attrs: XmlParser.#parseAttrs(s.slice(attrsStart, i)),
						selfClose: true,
						end: k + 1,
					};
				}
				i++;
				continue;
			}
			if (c === ">") {
				return {
					name,
					attrs: XmlParser.#parseAttrs(s.slice(attrsStart, i)),
					selfClose: false,
					end: i + 1,
				};
			}
			i++;
		}

		// Hit EOF without closing — not a parseable opener.
		return null;
	}

	static #parseAttrs(raw) {
		const attrs = {};
		let i = 0;
		while (i < raw.length) {
			while (i < raw.length && WS.test(raw[i])) i++;
			if (i >= raw.length) break;

			const keyStart = i;
			while (i < raw.length && ATTR_KEY_CHAR.test(raw[i])) i++;
			if (i === keyStart) {
				i++;
				continue;
			}
			const key = raw.slice(keyStart, i).toLowerCase();

			while (i < raw.length && WS.test(raw[i])) i++;

			if (raw[i] !== "=") {
				attrs[key] = "";
				continue;
			}
			i++;

			while (i < raw.length && WS.test(raw[i])) i++;

			if (raw[i] === '"' || raw[i] === "'") {
				const quote = raw[i];
				i++;
				const valStart = i;
				while (i < raw.length && raw[i] !== quote) i++;
				attrs[key] = raw.slice(valStart, i);
				if (raw[i] === quote) i++;
			} else {
				const valStart = i;
				while (i < raw.length && !WS.test(raw[i])) i++;
				attrs[key] = raw.slice(valStart, i);
			}
		}
		return attrs;
	}

	// Scans body content from `fromPos` until the matching `</name>` closer,
	// counting depth so same-name nested examples don't prematurely close.
	// Returns { bodyEnd, afterClose, unclosed }.
	//
	// Strict body opacity: only `</name>` (matching the open) and same-name
	// nested opens affect parsing. Mismatched closes of OTHER tag names are
	// body content, period.
	//
	// Backtick fences (`…`, ```…```) inside the body suppress all tag
	// recognition — a markdown table cell containing `<set>` examples
	// stays as content, not interpreted as a nested tag. This matches
	// the outer-level convention and is the load-bearing reason a model
	// can write documentation about rummy commands inside a deliverable
	// body without breaking parsing.
	//
	// If the matching close never arrives, emit "Unclosed" so the model
	// sees a clear failure and corrects on the next turn.
	static #findBodyEnd(s, name, fromPos) {
		let depth = 1;
		let i = fromPos;
		let inSingleBacktick = false;
		let inTripleFence = false;
		while (i < s.length) {
			if (s[i] === "`" && s[i + 1] === "`" && s[i + 2] === "`") {
				inTripleFence = !inTripleFence;
				i += 3;
				continue;
			}
			if (s[i] === "`" && !inTripleFence) {
				inSingleBacktick = !inSingleBacktick;
				i++;
				continue;
			}
			if (inSingleBacktick || inTripleFence || s[i] !== "<") {
				i++;
				continue;
			}
			if (s[i + 1] === "/") {
				const nameStart = i + 2;
				let nameEnd = nameStart;
				while (nameEnd < s.length && NAME_CHAR.test(s[nameEnd])) nameEnd++;
				const closeName = s.slice(nameStart, nameEnd).toLowerCase();
				let k = nameEnd;
				while (k < s.length && WS.test(s[k])) k++;
				const isCloseTag = s[k] === ">";

				if (isCloseTag && closeName === name) {
					depth--;
					if (depth === 0) {
						return { bodyEnd: i, afterClose: k + 1, unclosed: false };
					}
					i = k + 1;
					continue;
				}
			}
			const opener = XmlParser.#matchOpener(s, i);
			if (opener && opener.name === name && !opener.selfClose) {
				depth++;
				i = opener.end;
				continue;
			}
			i++;
		}
		return { bodyEnd: s.length, afterClose: s.length, unclosed: true };
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
