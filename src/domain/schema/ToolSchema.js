import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, "tools");

const SHARED_TOOLS = ["write", "summary", "unknown", "read", "drop", "env", "prompt"];
const ACT_TOOLS = ["run", "delete", "edit"];
const ALL_TOOL_NAMES = [...SHARED_TOOLS, ...ACT_TOOLS];

// Keywords that OpenAI strict mode doesn't support
const UNSUPPORTED_STRICT_KEYWORDS = new Set([
	"minLength", "maxLength", "minItems", "maxItems",
	"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
	"pattern", "multipleOf",
]);

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

// Load all tool JSON files, keyed by function.name
const masterTools = {};
for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".json"))) {
	const tool = JSON.parse(readFileSync(join(TOOLS_DIR, file), "utf8"));
	masterTools[tool.function.name] = tool;
}

// Validate all expected tools are loaded
for (const name of ALL_TOOL_NAMES) {
	if (!masterTools[name]) throw new Error(`Missing tool definition: ${name}`);
}

const askTools = SHARED_TOOLS.map((name) => masterTools[name]);
const actTools = ALL_TOOL_NAMES.map((name) => masterTools[name]);

const askToolsApi = stripUnsupported(askTools);
const actToolsApi = stripUnsupported(actTools);

// Build AJV validators for each tool's parameters
const ajv = new Ajv({ allErrors: true });
const validators = {};
for (const [name, tool] of Object.entries(masterTools)) {
	validators[name] = ajv.compile(tool.function.parameters);
}

export default class ToolSchema {
	static master = masterTools;
	static ask = askTools;
	static act = actTools;
	static askApi = askToolsApi;
	static actApi = actToolsApi;
	static askNames = new Set(SHARED_TOOLS);
	static actNames = new Set(ALL_TOOL_NAMES);

	static validate(toolName, args) {
		const validator = validators[toolName];
		if (!validator) return { valid: false, errors: [{ message: `Unknown tool: ${toolName}` }] };
		const valid = validator(args);
		return { valid, errors: valid ? null : [...validator.errors] };
	}

	static validateRequired(calledTools) {
		const names = calledTools instanceof Set ? calledTools : new Set(calledTools);
		const missing = [];
		if (!names.has("summary")) missing.push("summary");
		return { valid: missing.length === 0, missing };
	}

	static validateMode(mode, toolNames) {
		const allowed = mode === "act" ? ToolSchema.actNames : ToolSchema.askNames;
		const invalid = toolNames.filter((name) => !allowed.has(name));
		return { valid: invalid.length === 0, invalid };
	}
}
