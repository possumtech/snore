import { DOMParser } from "@xmldom/xmldom";
import picomatch from "picomatch";
import xpath from "xpath";

export const deterministic = true;

const cache = new Map();

// --- Detection ---

const XPATH_AXES = new Set([
	"child",
	"descendant",
	"descendant-or-self",
	"parent",
	"ancestor",
	"ancestor-or-self",
	"following",
	"following-sibling",
	"preceding",
	"preceding-sibling",
	"self",
	"attribute",
	"namespace",
]);

const XPATH_FUNCTIONS =
	/\b(position|last|contains|starts-with|not|text|count|sum|name|local-name|string-length|normalize-space|concat|substring|translate|boolean|number|string|true|false|ceiling|floor|round|id|lang|comment|processing-instruction)\s*\(/;

function isPlausibleJsonPath(pattern) {
	if (pattern.startsWith("$.")) {
		const after = pattern[2];
		if (!after) return false;
		if (/[a-zA-Z_*@.[[]/.test(after)) return !pattern.includes("/");
		return false;
	}
	if (pattern.startsWith("$[")) return !pattern.includes("/");
	if (pattern === "$..") return true;
	return false;
}

function hasXPathAxis(pattern) {
	const matches = pattern.matchAll(/(\w[\w-]*)(?=::)/g);
	for (const m of matches) {
		if (XPATH_AXES.has(m[1])) return true;
	}
	return false;
}

function hasXPathPredicate(pattern) {
	const brackets = pattern.matchAll(/\[([^\]]+)\]/g);
	for (const m of brackets) {
		const content = m[1];
		if (content.startsWith("@")) return true;
		if (/^\d+$/.test(content.trim())) return true;
		if (XPATH_FUNCTIONS.test(content)) return true;
	}
	return false;
}

function parseSed(pattern) {
	// s/search/replace/ or s/search/replace/flags
	if (!pattern.startsWith("s/")) return null;
	const parts = [];
	let i = 2;
	let current = "";
	while (i < pattern.length) {
		if (pattern[i] === "/" && pattern[i - 1] !== "\\") {
			parts.push(current);
			current = "";
		} else {
			current += pattern[i];
		}
		i++;
	}
	parts.push(current);
	if (parts.length < 2) return null;
	const search = parts[0];
	const replace = parts[1];
	const flags = parts[2] || "";
	return { search, replace, flags };
}

function detect(pattern) {
	// Sed-style: s/search/replace/flags
	if (pattern.startsWith("s/")) {
		const parsed = parseSed(pattern);
		if (parsed) return "sed";
	}

	// Explicit regex: /pattern/ or /pattern/flags
	if (
		pattern.startsWith("/") &&
		pattern.length > 2 &&
		/\/[gimsuy]*$/.test(pattern.slice(1))
	) {
		const lastSlash = pattern.lastIndexOf("/");
		if (lastSlash > 0) return "regex";
	}

	// JSONPath
	if (
		(pattern.startsWith("$.") ||
			pattern.startsWith("$[") ||
			pattern.startsWith("$..")) &&
		isPlausibleJsonPath(pattern)
	) {
		return "jsonpath";
	}

	// XPath
	if (
		pattern.startsWith("//") &&
		pattern.length > 2 &&
		/[a-zA-Z_*@.]/.test(pattern[2])
	) {
		return "xpath";
	}

	if (pattern.startsWith("/")) {
		if (hasXPathAxis(pattern)) return "xpath";
		if (hasXPathPredicate(pattern)) return "xpath";
	}

	// Glob: ** or unescaped * ? not after .
	if (pattern.includes("**")) return "glob";
	if (/(?:^|[^.\\])[*?]/.test(pattern)) return "glob";

	// Everything else is literal
	return "literal";
}

// --- Compilation ---

// Glob matching delegated to picomatch (standard, battle-tested).

function parseRegex(pattern) {
	const lastSlash = pattern.lastIndexOf("/");
	const body = pattern.slice(1, lastSlash);
	const flags = pattern.slice(lastSlash + 1);
	return { body, flags };
}

function parseJsonPath(path) {
	const segments = [];
	let i = path.startsWith("$") ? 1 : 0;

	while (i < path.length) {
		if (path[i] === ".") {
			if (path[i + 1] === ".") {
				segments.push({ type: "recursive" });
				i += 2;
				const start = i;
				while (i < path.length && path[i] !== "." && path[i] !== "[") i++;
				const key = path.slice(start, i);
				if (key === "*") segments.push({ type: "wildcard" });
				else if (key) segments.push({ type: "key", value: key });
			} else {
				i++;
				const start = i;
				while (i < path.length && path[i] !== "." && path[i] !== "[") i++;
				const key = path.slice(start, i);
				if (key === "*") segments.push({ type: "wildcard" });
				else if (key) segments.push({ type: "key", value: key });
			}
		} else if (path[i] === "[") {
			i++;
			if (path[i] === "*") {
				segments.push({ type: "wildcard" });
				i += 2;
			} else if (path[i] === "'" || path[i] === '"') {
				const quote = path[i];
				i++;
				const start = i;
				while (i < path.length && path[i] !== quote) i++;
				segments.push({ type: "key", value: path.slice(start, i) });
				i += 2;
			} else {
				const start = i;
				while (i < path.length && path[i] !== "]") i++;
				segments.push({
					type: "index",
					value: parseInt(path.slice(start, i), 10),
				});
				i++;
			}
		} else {
			i++;
		}
	}
	return segments;
}

function compile(pattern) {
	const type = detect(pattern);
	switch (type) {
		case "literal":
			return { type, pattern };
		case "glob": {
			const escaped = pattern.replace(/([()])/g, "\\$1");
			// Scheme paths have no directory structure — * matches everything
			const opts = escaped.includes("://")
				? {
						dot: true,
						nobrace: true,
						noextglob: true,
						bash: false,
						regex: true,
					}
				: { dot: true, nobrace: true, noextglob: true };

			// For scheme paths, convert single * after :// to ** so it crosses "/"
			const prepared = escaped.includes("://")
				? escaped.replace(/:\/\/\*(?!\*)/, "://**")
				: escaped;

			const isMatch = picomatch(prepared, opts);
			const picoRe = picomatch.makeRe(prepared, opts);
			return { type, isMatch, searchRe: picoRe };
		}
		case "regex": {
			const { body, flags } = parseRegex(pattern);
			return {
				type,
				re: new RegExp(body, flags || undefined),
				reGlobal: new RegExp(body, flags.includes("g") ? flags : `${flags}g`),
			};
		}
		case "sed": {
			const parsed = parseSed(pattern);
			const isRegex = parsed.flags.length > 0;
			return {
				type,
				search: parsed.search,
				replace: parsed.replace,
				flags: parsed.flags,
				isRegex,
				re: isRegex ? new RegExp(parsed.search, parsed.flags) : null,
			};
		}
		case "xpath":
			return { type, expr: pattern };
		case "jsonpath":
			return { type, segments: parseJsonPath(pattern) };
	}
}

// --- XPath evaluation ---

function evalXpath(expr, string) {
	try {
		const doc = new DOMParser().parseFromString(string, "text/xml");
		const nodes = xpath.select(expr, doc);
		if (!nodes || nodes.length === 0) return null;
		const node = nodes[0];
		return { match: node.textContent, node };
	} catch {
		return null;
	}
}

// --- JSONPath evaluation ---

function evalJsonPath(segments, string) {
	let current;
	try {
		current = [JSON.parse(string)];
	} catch {
		return null;
	}

	for (const seg of segments) {
		const next = [];
		for (const node of current) {
			if (node === null || node === undefined) continue;
			switch (seg.type) {
				case "key":
					if (typeof node === "object" && seg.value in node) {
						next.push(node[seg.value]);
					}
					break;
				case "index":
					if (Array.isArray(node) && seg.value < node.length) {
						next.push(node[seg.value]);
					}
					break;
				case "wildcard":
					if (Array.isArray(node)) next.push(...node);
					else if (typeof node === "object") next.push(...Object.values(node));
					break;
				case "recursive":
					next.push(node);
					collectDescendants(node, next);
					break;
			}
		}
		if (next.length === 0) return null;
		current = next;
	}
	return current.length > 0 ? current : null;
}

function collectDescendants(node, out) {
	if (node === null || typeof node !== "object") return;
	const values = Array.isArray(node) ? node : Object.values(node);
	for (const v of values) {
		if (v !== null && typeof v === "object") {
			out.push(v);
			collectDescendants(v, out);
		}
	}
}

// --- Public API ---

/**
 * hedmatch — does the pattern match the ENTIRE string?
 * For path matching, WHERE clauses, full-string comparison.
 */
export function hedmatch(pattern, string) {
	if (string === null) return false;

	let compiled = cache.get(pattern);
	if (!compiled) {
		compiled = compile(pattern);
		cache.set(pattern, compiled);
	}

	switch (compiled.type) {
		case "literal":
			return string === compiled.pattern;
		case "glob":
			return compiled.isMatch(string);
		case "regex":
			return compiled.re.test(string);
		case "sed":
			return compiled.isRegex
				? compiled.re.test(string)
				: string.includes(compiled.search);
		case "xpath":
			return evalXpath(compiled.expr, string) !== null;
		case "jsonpath":
			return evalJsonPath(compiled.segments, string) !== null;
	}
	return false;
}

/**
 * hedsearch — find the pattern anywhere IN the string.
 * For substring search, content filtering, "does this text contain...".
 * Returns { found, match, index } or { found: false }.
 */
export function hedsearch(pattern, string) {
	if (string === null) return { found: false };

	let compiled = cache.get(pattern);
	if (!compiled) {
		compiled = compile(pattern);
		cache.set(pattern, compiled);
	}

	switch (compiled.type) {
		case "literal": {
			const idx = string.indexOf(compiled.pattern);
			if (idx === -1) return { found: false };
			return { found: true, match: compiled.pattern, index: idx };
		}
		case "glob": {
			const m = compiled.searchRe.exec(string);
			if (!m) return { found: false };
			return { found: true, match: m[0], index: m.index };
		}
		case "regex": {
			const m = compiled.re.exec(string);
			if (!m) return { found: false };
			return { found: true, match: m[0], index: m.index };
		}
		case "sed": {
			if (compiled.isRegex) {
				compiled.re.lastIndex = 0;
				const m = compiled.re.exec(string);
				if (!m) return { found: false };
				return { found: true, match: m[0], index: m.index };
			}
			const idx = string.indexOf(compiled.search);
			if (idx === -1) return { found: false };
			return { found: true, match: compiled.search, index: idx };
		}
		case "xpath": {
			const result = evalXpath(compiled.expr, string);
			if (!result) return { found: false };
			return { found: true, match: result.match, index: 0 };
		}
		case "jsonpath": {
			const result = evalJsonPath(compiled.segments, string);
			if (!result) return { found: false };
			return { found: true, match: result[0], index: 0 };
		}
	}
	return { found: false };
}

/**
 * hedreplace — find pattern in string, replace with replacement.
 * Returns the new string, or null if pattern not found.
 */
export function hedreplace(pattern, replacement, string) {
	if (string === null) return null;

	let compiled = cache.get(pattern);
	if (!compiled) {
		compiled = compile(pattern);
		cache.set(pattern, compiled);
	}

	switch (compiled.type) {
		case "literal": {
			if (!string.includes(compiled.pattern)) return null;
			return string.replaceAll(compiled.pattern, replacement);
		}
		case "glob": {
			if (!compiled.searchRe.test(string)) return null;
			return string.replace(compiled.searchRe, replacement);
		}
		case "regex": {
			if (!compiled.re.test(string)) return null;
			compiled.re.lastIndex = 0;
			compiled.reGlobal.lastIndex = 0;
			return string.replace(compiled.reGlobal, replacement);
		}
		case "sed": {
			// For sed, replacement is embedded in the pattern. Ignore the argument.
			if (compiled.isRegex) {
				compiled.re.lastIndex = 0;
				if (!compiled.re.test(string)) return null;
				compiled.re.lastIndex = 0;
				return string.replace(compiled.re, compiled.replace);
			}
			if (!string.includes(compiled.search)) return null;
			return string.replaceAll(compiled.search, compiled.replace);
		}
		case "xpath":
		case "jsonpath":
			return null;
	}
	return null;
}

// SQL functions are in separate files (hedmatch.js, hedsearch.js)
// that import from this library. Filename = SQL function name.
