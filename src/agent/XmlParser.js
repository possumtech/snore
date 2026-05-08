import { parseMarkerBody } from "../lib/hedberg/marker.js";

// `<<:::IDENT...:::IDENT` body opacity. When `#findBodyEnd` is scanning
// a `<set>` body and hits `<<:::`, jump past the matching `:::IDENT`
// closer so tag-shaped content inside the marker (`</set>`, `<get/>`,
// etc.) doesn't trigger structural recovery.
function skipEditMarker(s, pos) {
	const m = s.slice(pos).match(/^<<:::([A-Za-z_][A-Za-z0-9_./-]*)/);
	if (!m) return null;
	const ident = m[1];
	const openerEnd = pos + m[0].length;
	const escIdent = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const closerRe = new RegExp(`:::${escIdent}(?![A-Za-z0-9_])`);
	const cm = s.slice(openerEnd).match(closerRe);
	if (!cm) return null;
	return openerEnd + cm.index + cm[0].length;
}

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
		// `search`/`replace` as attributes is no longer in the grammar;
		// strip them so they can't sneak past via the attribute spread.
		const { search: _s, replace: _r, ...rest } = a;
		a = rest;

		// Self-close / no-body: visibility/metadata op.
		if (!trimmed) return { name, ...a, body: a.body || "" };

		// Edit syntax (SPEC.md "Edit Syntax"): walks the body for
		// `<<:::IDENT...:::IDENT` markers and returns an ordered op
		// list. No markers → plain body, treated as full-replace.
		// Non-keyword IDENTs (path-flavored, identifier-flavored)
		// route to REPLACE so the model gets a working write whatever
		// IDENT it picks.
		const { ops, error } = parseMarkerBody(rawBody);
		if (error) return { name, ...a, error };
		if (ops) return { name, ...a, operations: ops };

		// No markers — plain body, full-replace.
		return { name, ...a, body: trimmed };
	}

	if (name === "update") {
		const body = trimmed || a.body || "";
		const status = a.status ? Number(a.status) : 102;
		return { name, ...a, body, status };
	}

	// Body shorthand fallback: when the attribute is unset (undefined),
	// fall back to the trimmed body. Empty-string attrs are preserved
	// as-is — handlers validate. `||` would conflate the two cases.
	const fromBody = trimmed === "" ? null : trimmed;

	if (name === "get" || name === "rm") {
		return { name, ...a, path: a.path ?? fromBody };
	}

	if (name === "search") {
		const path = a.path ?? fromBody;
		const results = a.results ? Number(a.results) : null;
		return { name, ...a, path, results };
	}

	if (name === "mv" || name === "cp") {
		return { name, ...a, path: a.path, to: a.to ?? fromBody };
	}

	if (name === "sh" || name === "env") {
		const command = a.command ?? fromBody;
		return { name, ...a, command };
	}

	if (name === "ask_user") {
		const question = a.question ?? null;
		const options = a.options ?? fromBody;
		return { name, ...a, question, options };
	}

	return { name, ...a, body: trimmed === "" ? a.body : trimmed };
}

const NAME_CHAR = /[a-zA-Z0-9_]/;
const ATTR_KEY_CHAR = /[a-zA-Z0-9_:-]/;
const WS = /\s/;

// Tokenizer for rummy's closed set of tool tags. Body opacity for closed
// bodies; tail recovery for unclosed bodies.
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
//     suppress tag recognition AT THE OUTER LEVEL ONLY (between tool
//     calls). Documentation prose with backticked tag examples doesn't
//     get parsed as commands. Inside tool bodies backticks are content;
//     bodies that need opacity for tag-like content use the edit-syntax
//     marker family (see SPEC.md "Edit Syntax"), which has no
//     false-positive failure modes (unlike inside-body backtick
//     tracking, which would suppress closing tags on bodies with stray
//     unbalanced backticks).
//   - Edit-syntax marker opacity (set only): `<<:::IDENT...:::IDENT`
//     spans inside a `<set>` body are skipped during tag detection so
//     content with `</set>` literals or marker-shaped text stays as
//     body. Multiple markers per body supported; see marker.js.
//   - Same-name nesting (`<set>...<set/>...</set>`) is depth-counted so
//     nested examples don't prematurely close the outer. Same-name
//     nesting also disables tail recovery — the model's intent is clearly
//     opaque body content.
//   - Unclosed openers (no matching close, no same-name nesting) try
//     tail recovery: scan the captured body for the leftmost position
//     whose suffix tokenizes cleanly into ≥1 well-formed tool calls
//     with zero leftover text. If found, end the unclosed body there
//     and let the trailing tags parse as proper siblings. The warning
//     surfaces "Unclosed <name> — recovered N trailing tool call(s)"
//     so the model can see what happened. If recovery finds nothing,
//     capture body to EOF and emit "Unclosed <name> — content captured
//     anyway".
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
				if (result.recoveredTailCount) {
					warnings.push(
						`Unclosed <${name}> tag — recovered ${result.recoveredTailCount} trailing tool call(s)`,
					);
				} else {
					warnings.push(`Unclosed <${name}> tag — content captured anyway`);
				}
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
		let sameNameNested = false;
		let i = fromPos;
		while (i < s.length) {
			// Edit-syntax marker opacity: <<:::IDENT...:::IDENT spans are
			// opaque — tag detection skips them so inner `</set>` and
			// other tag-shaped content stays as body. Multiple markers
			// per `<set>` body are supported; check on every iteration.
			if (name === "set" && s.startsWith("<<:::", i)) {
				const skipTo = skipEditMarker(s, i);
				if (skipTo != null) {
					i = skipTo;
					continue;
				}
			}
			if (s[i] !== "<") {
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
				sameNameNested = true;
				i = opener.end;
				continue;
			}
			i++;
		}
		// Unclosed: try tail recovery, but only if the body never
		// nested a same-name opener. Same-name nesting is the model
		// deliberately using opaque body for examples (`<set>` writing
		// docs about `<set>`); we trust the body content as authored.
		// No nesting means a plain botched `</set>` — recovery is safe.
		// If the body's tail is a clean sequence of one or more
		// well-formed tool calls (zero leftover text), end the body
		// at the start of that tail and let the outer tokenizer parse
		// those calls as proper siblings. Closes the silent-swallow
		// gap when a model botches `</set>` after SEARCH/REPLACE and
		// emits trailing `<sh>` / `<update>`.
		if (sameNameNested) {
			return { bodyEnd: s.length, afterClose: s.length, unclosed: true };
		}
		const recovery = XmlParser.#findTailRecovery(s, fromPos);
		if (recovery) {
			return {
				bodyEnd: recovery.tailStart,
				afterClose: recovery.tailStart,
				unclosed: true,
				recoveredTailCount: recovery.commandCount,
			};
		}
		return { bodyEnd: s.length, afterClose: s.length, unclosed: true };
	}

	// Scan body content for the leftmost position whose suffix tokenizes
	// cleanly into ≥1 commands with no leftover non-whitespace text.
	// Returns { tailStart, commandCount } or null. Only considers opener
	// positions; treats the suffix as outer-level so backtick fences and
	// tag recognition match the parent tokenizer's behavior.
	static #findTailRecovery(s, fromPos) {
		let best = null;
		let i = fromPos;
		while (i < s.length) {
			if (s[i] === "<" && XmlParser.#matchOpener(s, i)) {
				const suffix = s.slice(i);
				const result = XmlParser.#tokenize(suffix, []);
				if (result.commands.length > 0 && result.unparsed === "") {
					best = { tailStart: i, commandCount: result.commands.length };
					break;
				}
			}
			i++;
		}
		return best;
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
