import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, "tools");

const SHARED_TOOLS = ["known", "summary", "unknown", "read", "drop", "env", "prompt"];
const ACT_TOOLS = ["run", "delete", "edit"];

// Keywords that OpenAI strict mode doesn't support
const UNSUPPORTED_STRICT_KEYWORDS = new Set([
	"minLength", "maxLength", "minItems", "maxItems",
	"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
	"pattern", "multipleOf",
]);

/**
 * Deep-clone an object, stripping keys that OpenAI strict mode rejects.
 */
function stripUnsupported(obj) {
	if (Array.isArray(obj)) return obj.map(stripUnsupported);
	if (obj === null || typeof obj !== "object") return obj;
	const result = {};
	for (const [k, v] of Object.entries(obj)) {
		if (UNSUPPORTED_STRICT_KEYWORDS.has(k)) continue;
		result[k] = stripUnsupported(v);
	}
	return result;
}

function loadTool(name) {
	return JSON.parse(readFileSync(join(TOOLS_DIR, `${name}.json`), "utf8"));
}

const masterTools = Object.fromEntries(
	[...SHARED_TOOLS, ...ACT_TOOLS].map((name) => [name, loadTool(name)]),
);

const askTools = SHARED_TOOLS.map((name) => masterTools[name]);
const actTools = [...SHARED_TOOLS, ...ACT_TOOLS].map((name) => masterTools[name]);

// API-ready versions (stripped of unsupported keywords)
const askToolsApi = stripUnsupported(askTools);
const actToolsApi = stripUnsupported(actTools);

// Build AJV validators for each tool's parameters
const ajv = new Ajv({ allErrors: true });
const validators = {};
for (const [name, tool] of Object.entries(masterTools)) {
	validators[name] = ajv.compile(tool.function.parameters);
}

export default class ToolSchema {
	/** Master tool definitions (full JSON Schema, including minLength etc.) */
	static master = masterTools;

	/** Ask-mode tool array (full schemas) */
	static ask = askTools;

	/** Act-mode tool array (full schemas) */
	static act = actTools;

	/** Ask-mode for API (stripped of unsupported strict keywords) */
	static askApi = askToolsApi;

	/** Act-mode for API (stripped of unsupported strict keywords) */
	static actApi = actToolsApi;

	/** Tool names by mode */
	static askNames = new Set(SHARED_TOOLS);
	static actNames = new Set([...SHARED_TOOLS, ...ACT_TOOLS]);

	/**
	 * Validate tool call arguments against the master schema.
	 * @param {string} toolName
	 * @param {object} args - Parsed arguments object
	 * @returns {{ valid: boolean, errors: Array|null }}
	 */
	static validate(toolName, args) {
		const validator = validators[toolName];
		if (!validator) return { valid: false, errors: [{ message: `Unknown tool: ${toolName}` }] };
		const valid = validator(args);
		return { valid, errors: valid ? null : [...validator.errors] };
	}

	/**
	 * Validate that required tools are present in a set of tool call names.
	 * @param {Set|Array} calledTools - tool names from the response
	 * @returns {{ valid: boolean, missing: string[] }}
	 */
	static validateRequired(calledTools) {
		const names = calledTools instanceof Set ? calledTools : new Set(calledTools);
		const missing = [];
		if (!names.has("known")) missing.push("known");
		if (!names.has("summary")) missing.push("summary");
		return { valid: missing.length === 0, missing };
	}

	/**
	 * Validate that all tool names are valid for the given mode.
	 * @param {string} mode - "ask" or "act"
	 * @param {Array} toolNames
	 * @returns {{ valid: boolean, invalid: string[] }}
	 */
	static validateMode(mode, toolNames) {
		const allowed = mode === "act" ? ToolSchema.actNames : ToolSchema.askNames;
		const invalid = toolNames.filter((name) => !allowed.has(name));
		return { valid: invalid.length === 0, invalid };
	}
}
