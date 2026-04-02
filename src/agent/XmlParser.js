import { Parser } from "htmlparser2";

const STORE_TOOLS = new Set([
	"read",
	"store",
	"delete",
	"write",
	"move",
	"copy",
	"search",
]);
const ALL_TOOLS = new Set([
	...STORE_TOOLS,
	"run",
	"env",
	"ask_user",
	"summarize",
	"update",
	"unknown",
]);

function parseEditContent(content) {
	const blocks = [];

	// Format 1: Git merge conflict style
	const mergeRe =
		/<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
	for (const m of content.matchAll(mergeRe)) {
		blocks.push({ search: m[1], replace: m[2] });
	}
	if (blocks.length > 0) return blocks;

	// Format 2: Replace-only (no search block)
	const replaceOnly = /^=======\n([\s\S]*?)\n>>>>>>> REPLACE/gm;
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

	if (name === "write") {
		// Structured edit detection — merge conflict, udiff, Claude XML
		const hasEdit =
			trimmed.includes("<<<<<<< SEARCH") ||
			trimmed.includes(">>>>>>> REPLACE") ||
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
		// JSON { search, replace } healing — models sometimes produce this
		if (trimmed.startsWith("{") && trimmed.includes('"search"')) {
			try {
				const json = JSON.parse(trimmed);
				if (json.search != null) {
					return {
						name,
						path: a.path,
						search: json.search,
						replace: json.replace ?? "",
					};
				}
			} catch {}
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
		// Body + body attr → bulk update (body filters, trimmed replaces)
		if (trimmed && a.body) {
			return {
				name,
				path: a.path,
				filter: a.body,
				body: trimmed,
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

	if (name === "read" || name === "store" || name === "delete") {
		const path = a.path || trimmed || null;
		return { name, path, body: a.body, preview: a.preview };
	}

	if (name === "search") {
		const path = a.path || trimmed || null;
		const results = a.results ? Number(a.results) : null;
		return { name, path, results };
	}

	if (name === "move" || name === "copy") {
		const to = a.to || trimmed || null;
		return { name, path: a.path, to };
	}

	if (name === "run" || name === "env") {
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
			commands.push(resolveCommand(current.name, current.attrs, current.rawBody));
			current = null;
		}

		const unparsed = textChunks.join("").trim();
		return { commands, warnings, unparsed };
	}
}
