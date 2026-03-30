import ToolSchema from "../schema/ToolSchema.js";

/**
 * ResponseHealer: centralized model output healing.
 * Takes raw tool calls from the LLM response, validates via AJV,
 * applies healing rules, and returns cleaned calls + warnings.
 *
 * Rules:
 * - summary text truncated to 80 chars
 * - empty key/value strings healed where possible
 * - unknown args normalized
 * - invalid tool names warned
 * - all AJV errors collected as warnings, not thrown
 */

const RULES = [
	{
		name: "summary_truncate",
		match: (call) => call.name === "summary" && call.args.text?.length > 80,
		heal: (call) => {
			const original = call.args.text.length;
			call.args.text = call.args.text.slice(0, 80);
			return `Summary truncated from ${original} to 80 chars`;
		},
	},
	{
		name: "summary_empty",
		match: (call) => call.name === "summary" && !call.args.text,
		heal: (call) => {
			call.args.text = "(no summary provided)";
			return "Summary was empty, placeholder inserted";
		},
	},
	{
		name: "write_empty_key",
		match: (call) => call.name === "write" && !call.args.key,
		heal: () => null,
		reject: true,
		reason: "write call with empty key — dropped",
	},
	{
		name: "unknown_empty_text",
		match: (call) => call.name === "unknown" && !call.args.text,
		heal: () => null,
		reject: true,
		reason: "unknown call with empty text — dropped",
	},
	{
		name: "read_empty_key",
		match: (call) => call.name === "read" && !call.args.key,
		heal: () => null,
		reject: true,
		reason: "read call with empty key — dropped",
	},
];

export default class ResponseHealer {
	/**
	 * Heal raw tool calls from the LLM response.
	 * @param {Array} toolCalls - raw tool_calls from the response message
	 * @param {string} mode - "ask" or "act"
	 * @returns {{ calls: Array<{id, name, args}>, warnings: string[] }}
	 */
	static heal(toolCalls, mode) {
		const warnings = [];
		const calls = [];

		for (const tc of toolCalls) {
			const name = tc.function?.name;
			const args = JSON.parse(tc.function?.arguments || "{}");
			const id = tc.id;
			const call = { id, name, args };

			// Mode validation
			const { valid: modeValid } = ToolSchema.validateMode(mode, [name]);
			if (!modeValid) {
				warnings.push(`Tool '${name}' not allowed in ${mode} mode — dropped`);
				continue;
			}

			// Apply healing rules BEFORE AJV (so healed values pass validation)
			let rejected = false;
			for (const rule of RULES) {
				if (!rule.match(call)) continue;
				if (rule.reject) {
					warnings.push(rule.reason);
					rejected = true;
					break;
				}
				const msg = rule.heal(call);
				if (msg) warnings.push(msg);
			}
			if (rejected) continue;

			// AJV validation (on healed args)
			const { valid, errors } = ToolSchema.validate(name, args);
			if (!valid) {
				const msgs = errors.map((e) => e.message).join(", ");
				warnings.push(`${name}: ${msgs}`);
			}

			calls.push(call);
		}

		return { calls, warnings };
	}
}
