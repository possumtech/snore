import { JSDOM } from "jsdom";

export const deterministic = true;

const cache = new Map();

// --- Detection ---

const XPATH_AXES = new Set([
	"child", "descendant", "descendant-or-self", "parent", "ancestor",
	"ancestor-or-self", "following", "following-sibling", "preceding",
	"preceding-sibling", "self", "attribute", "namespace",
]);

const XPATH_FUNCTIONS = /\b(position|last|contains|starts-with|not|text|count|sum|name|local-name|string-length|normalize-space|concat|substring|translate|boolean|number|string|true|false|ceiling|floor|round|id|lang|comment|processing-instruction)\s*\(/;

const UNAMBIGUOUS_REGEX = /\\[dwsbBDWSn]|\(\?|^\^|\.\+|\.\*|\.\?|\([^)]*\|[^)]*\)|\{\d+\}|\{\d+,\d*\}/;

function isPlausibleJsonPath(pattern) {
	if (pattern.startsWith("$.")) {
		const after = pattern[2];
		if (!after) return false;
		if (/[a-zA-Z_*@.[\[]/.test(after)) return !pattern.includes("/");
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

function detect(pattern) {
	if ((pattern.startsWith("$.") || pattern.startsWith("$[") || pattern.startsWith("$..")) && isPlausibleJsonPath(pattern)) {
		return "jsonpath";
	}

	if (pattern.startsWith("//") && pattern.length > 2 && /[a-zA-Z_*@.]/.test(pattern[2])) {
		return "xpath";
	}

	if (pattern.startsWith("/")) {
		if (hasXPathAxis(pattern)) return "xpath";
		if (hasXPathPredicate(pattern)) return "xpath";
	}

	if (UNAMBIGUOUS_REGEX.test(pattern)) return "regex";

	return "glob";
}

// --- Compilation ---

function globToRegex(glob) {
	let result = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				result += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else {
				result += "[^/]*";
			}
		} else if (c === "?") result += "[^/]";
		else if (c === "[") {
			const close = glob.indexOf("]", i + 1);
			if (close === -1) {
				result += "\\[";
				continue;
			}
			result += glob.slice(i, close + 1);
			i = close;
		} else if (/[.+^${}()|\\]/.test(c)) {
			result += `\\${c}`;
		} else result += c;
	}
	return `${result}$`;
}

function parseJsonPath(path) {
	const segments = [];
	let i = path.startsWith("$") ? 1 : 0;

	while (i < path.length) {
		if (path[i] === ".") {
			if (path[i + 1] === ".") {
				segments.push({ type: "recursive" });
				i += 2;
				// Parse the key immediately after ..
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
				i += 2; // skip *]
			} else if (path[i] === "'" || path[i] === '"') {
				const quote = path[i];
				i++;
				const start = i;
				while (i < path.length && path[i] !== quote) i++;
				segments.push({ type: "key", value: path.slice(start, i) });
				i += 2; // skip quote]
			} else {
				const start = i;
				while (i < path.length && path[i] !== "]") i++;
				segments.push({ type: "index", value: parseInt(path.slice(start, i), 10) });
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
		case "glob":
			return { type, re: new RegExp(globToRegex(pattern)) };
		case "regex":
			return { type, re: new RegExp(pattern) };
		case "xpath":
			return { type, expr: pattern.startsWith("//") ? pattern : pattern };
		case "jsonpath":
			return { type, segments: parseJsonPath(pattern) };
	}
}

// --- Matching ---

function evalXpath(expr, string) {
	try {
		const dom = new JSDOM(string, { contentType: "text/xml" });
		const doc = dom.window.document;
		const result = doc.evaluate(expr, doc, null, 0, null);
		return result.iterateNext() !== null;
	} catch {
		return false;
	}
}

function evalJsonPath(segments, string) {
	let current;
	try {
		current = [JSON.parse(string)];
	} catch {
		return false;
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
		if (next.length === 0) return false;
		current = next;
	}
	return current.length > 0;
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

// --- Entry point ---

export default function hedberg(pattern, string) {
	if (string === null) return 0;

	let compiled = cache.get(pattern);
	if (!compiled) {
		compiled = compile(pattern);
		cache.set(pattern, compiled);
	}

	switch (compiled.type) {
		case "glob":
		case "regex":
			return compiled.re.test(string) ? 1 : 0;
		case "xpath":
			return evalXpath(compiled.expr, string) ? 1 : 0;
		case "jsonpath":
			return evalJsonPath(compiled.segments, string) ? 1 : 0;
	}
	return 0;
}
