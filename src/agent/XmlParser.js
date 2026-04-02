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

/**
 * Normalize legacy and alternative attribute names to canonical form.
 * key="" → path="", file="" → path="". Silent, no warnings.
 */
function normalizeAttrs(attrs) {
	const out = { ...attrs };
	if (out.key && !out.path) {
		out.path = out.key;
		delete out.key;
	}
	if (out.file && !out.path) {
		out.path = out.file;
		delete out.file;
	}
	if ("keys" in out || "preview" in out) out.preview = true;
	return out;
}

/**
 * Resolve the competing attr-vs-body philosophies per tool.
 * If the canonical attribute is missing, the body fills it. Silent.
 */
function resolveCommand(name, attrs, body) {
	const a = normalizeAttrs(attrs);
	const trimmed = body.trim();

	if (name === "write") {
		// SEARCH/REPLACE blocks in body → edit mode
		if (
			trimmed.includes("<<<<<<< SEARCH") ||
			trimmed.includes(">>>>>>> REPLACE")
		) {
			const blocks = parseEditContent(body);
			if (blocks.length > 0) {
				return {
					name,
					path: a.path,
					value: a.value,
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
				value: a.value,
				preview: a.preview,
				search: a.search,
				replace,
			};
		}
		// Body + value attr → bulk update (value filters, body replaces)
		if (trimmed && a.value) {
			return {
				name,
				path: a.path,
				filter: a.value,
				value: trimmed,
				preview: a.preview,
			};
		}
		// Plain write → create/overwrite
		const value = trimmed || a.value || "";
		return { name, path: a.path, value, preview: a.preview };
	}

	if (name === "summarize" || name === "update" || name === "unknown") {
		// Canonical: text in body. Alt: value in attr.
		const value = trimmed || a.value || "";
		return { name, value };
	}

	if (name === "read" || name === "store" || name === "delete") {
		// Canonical: path in attr. Alt: path in body.
		const path = a.path || trimmed || null;
		return { name, path, value: a.value, preview: a.preview };
	}

	if (name === "search") {
		// Canonical: path (query) in attr. Alt: query in body.
		const path = a.path || trimmed || null;
		const results = a.results ? Number(a.results) : null;
		return { name, path, results };
	}

	if (name === "move" || name === "copy") {
		// Canonical: path (from) and to attrs. Alt: to in body.
		const to = a.to || trimmed || null;
		return { name, path: a.path, to };
	}

	if (name === "run" || name === "env") {
		// Canonical: command in attr. Alt: command in body.
		const command = a.command || trimmed || null;
		return { name, command };
	}

	if (name === "ask_user") {
		// Canonical: question in attr, options in attr or body.
		const question = a.question || null;
		const options = a.options || trimmed || null;
		return { name, question, options };
	}

	return { name, ...a, value: trimmed || a.value };
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
							current.body += `<${name}>`;
						}
						return;
					}

					// Every tool can have a body — start collecting
					current = { name, attrs, body: "" };
				},

				ontext(text) {
					if (current) {
						current.body += text;
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
							resolveCommand(current.name, current.attrs, current.body),
						);
						current = null;
					} else if (current) {
						current.body += `</${name}>`;
					} else if (isImplied && ALL_TOOLS.has(name)) {
						// Self-closing tag that htmlparser2 auto-closed
						// Already handled by onopentag → current was set, body is empty
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
			commands.push(resolveCommand(current.name, current.attrs, current.body));
			current = null;
		}

		const unparsed = textChunks.join("").trim();
		return { commands, warnings, unparsed };
	}
}
