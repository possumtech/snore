import { Parser } from "htmlparser2";

const STORE_TOOLS = new Set([
	"get",
	"store",
	"rm",
	"set",
	"mv",
	"cp",
	"search",
]);
const ALL_TOOLS = new Set([
	...STORE_TOOLS,
	"known",
	"sh",
	"env",
	"ask_user",
	"summarize",
	"update",
	"unknown",
]);

function parseEditContent(content) {
	const blocks = [];

	// Format 1: Git merge conflict style (3-12 marker chars)
	const mergeRe =
		/<{3,12} SEARCH\n([\s\S]*?)\n={3,12}\n([\s\S]*?)\n>{3,12} REPLACE/g;
	for (const m of content.matchAll(mergeRe)) {
		blocks.push({ search: m[1], replace: m[2] });
	}
	if (blocks.length > 0) return blocks;

	// Format 2: Replace-only (no search block, 3-12 marker chars)
	const replaceOnly = /^={3,12}\n([\s\S]*?)\n>{3,12} REPLACE/gm;
	for (const m of content.matchAll(replaceOnly)) {
		blocks.push({ search: null, replace: m[1] });
	}
	if (blocks.length > 0) return blocks;

	// Format 3: Unified diff
	if (
		content.includes("@@") &&
		(content.includes("\n-") || content.includes("\n+"))
	) {
		const hunks = content.split(/^@@[^@]*@@/m).slice(1);
		for (const hunk of hunks) {
			const oldLines = [];
			const newLines = [];
			for (const line of hunk.split("\n")) {
				if (line.startsWith("-")) oldLines.push(line.slice(1));
				else if (line.startsWith("+")) newLines.push(line.slice(1));
				else if (line.startsWith(" ")) {
					oldLines.push(line.slice(1));
					newLines.push(line.slice(1));
				}
			}
			if (oldLines.length > 0 || newLines.length > 0) {
				blocks.push({
					search: oldLines.join("\n"),
					replace: newLines.join("\n"),
				});
			}
		}
	}
	if (blocks.length > 0) return blocks;

	// Format 4: Claude XML style
	const claudeRe =
		/<old_text>([\s\S]*?)<\/old_text>\s*<new_text>([\s\S]*?)<\/new_text>/g;
	for (const m of content.matchAll(claudeRe)) {
		blocks.push({ search: m[1], replace: m[2] });
	}

	return blocks;
}

/**
 * Normalize legacy and alternative attribute names to canonical form.
 * key="" → path="", file="" → path="". Silent, no warnings.
 */
const KNOWN_ATTRS = new Set([
	"path",
	"body",
	"preview",
	"question",
	"options",
	"search",
	"replace",
	"to",
	"results",
	"command",
	"warn",
]);

function normalizeAttrs(attrs) {
	const out = { ...attrs };
	// Heal legacy attr names
	if ("value" in out && !("body" in out)) {
		out.body = out.value;
		delete out.value;
	}
	// If no path, treat first unrecognized attribute value as path
	if (!out.path) {
		for (const [k, v] of Object.entries(out)) {
			if (!KNOWN_ATTRS.has(k) && v) {
				out.path = v;
				delete out[k];
				break;
			}
		}
	}
	if ("preview" in out) out.preview = true;
	return out;
}

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
		// JSON-style { search, replace } — accept valid JSON and =style variants
		if (trimmed.startsWith("{") && /search/.test(trimmed)) {
			let search = null;
			let replace = null;
			try {
				const json = JSON.parse(trimmed);
				search = json.search;
				replace = json.replace ?? "";
			} catch {
				// Try = style: { search="old", replace="new" }
				const searchMatch = trimmed.match(/search\s*=\s*"([^"]*)"/);
				const replaceMatch = trimmed.match(/replace\s*=\s*"([^"]*)"/);
				if (searchMatch) {
					search = searchMatch[1];
					replace = replaceMatch?.[1] ?? "";
				}
			}
			if (search != null) {
				return {
					name,
					path: a.path,
					search,
					replace,
				};
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
		// Plain write → create/overwrite
		const body = trimmed || a.body || "";
		return { name, path: a.path, body, preview: a.preview };
	}

	if (name === "summarize" || name === "update" || name === "unknown") {
		const body = trimmed || a.body || "";
		return { name, body };
	}

	if (name === "known") {
		const body = trimmed || a.body || "";
		const path = a.path || null;
		return { name, path, body };
	}

	if (name === "get" || name === "store" || name === "rm") {
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
							current.rawBody += `<${name}>`;
						}
						return;
					}

					current = { name, attrs, rawBody: "" };
				},

				ontext(text) {
					if (current) {
						current.rawBody += text;
					} else {
						textChunks.push(text);
					}
				},

				onclosetag(name, isImplied) {
					if (current && name === current.name) {
						if (ended) {
							warnings.push(`Unclosed <${name}> tag — content captured anyway`);
						}
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

		parser.write(content);
		ended = true;
		parser.end();

		// Flush any unclosed tool tag
		if (current) {
			warnings.push(`Unclosed <${current.name}> tag — content captured anyway`);
			commands.push(
				resolveCommand(current.name, current.attrs, current.rawBody),
			);
			current = null;
		}

		const unparsed = textChunks.join("").trim();
		return { commands, warnings, unparsed };
	}
}
