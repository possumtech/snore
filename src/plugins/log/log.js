import { stateToStatus } from "../../agent/httpStatus.js";

// sh/env span multiple channels; channels render their own tokens in <context>.
const STREAM_NO_TOKENS = new Set(["sh", "env"]);

export default class Log {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleLog.bind(this), 100);
	}

	async assembleLog(content, ctx) {
		// Includes prior prompts; the latest prompt is rendered separately as <prompt>.
		const latestPrompt = ctx.rows.findLast(
			(r) => r.category === "prompt" && r.scheme === "prompt",
		);
		const entries = ctx.rows.filter((r) => {
			if (r.category === "logging" && r.scheme === "log") return true;
			if (r.category === "prompt" && r.scheme === "prompt") {
				return r !== latestPrompt;
			}
			return false;
		});
		if (entries.length === 0) return content;
		const rowsByPath = new Map();
		for (const r of ctx.rows) rowsByPath.set(r.path, r);
		const lines = entries.map((e) => renderLogTag(e, rowsByPath));
		return `${content}<log>\n${lines.join("\n")}\n</log>\n`;
	}
}

// Action segment of log://turn_N/action/slug → XML tag.
function actionFromPath(path) {
	if (path?.startsWith("prompt://")) return "prompt";
	const match = path?.match(/^log:\/\/turn_\d+\/([^/]+)\//);
	return match ? match[1] : "log";
}

function renderLogTag(entry, rowsByPath) {
	const attrs =
		typeof entry.attributes === "string"
			? JSON.parse(entry.attributes)
			: entry.attributes;

	const action = actionFromPath(entry.path);

	const statusValue =
		attrs?.status != null
			? attrs.status
			: entry.state
				? stateToStatus(entry.state, entry.outcome)
				: null;
	// Suppress status on prompts; uniform 200 carries no signal.
	const status =
		statusValue != null && action !== "prompt"
			? ` status="${statusValue}"`
			: "";
	const outcomeAttr = entry.outcome ? ` outcome="${entry.outcome}"` : "";
	// tokens = aTokens of the thing this tag represents (target via attrs.path, else self).
	const isSlice = attrs?.lineStart != null;
	const targetEntry = attrs?.path ? rowsByPath.get(attrs.path) : null;
	let tokenSource = null;
	let lineSource = null;
	if (STREAM_NO_TOKENS.has(action)) {
		tokenSource = null;
		lineSource = null;
	} else if (isSlice) {
		tokenSource = entry.aTokens;
		lineSource = entry.vLines;
	} else if (targetEntry) {
		tokenSource = targetEntry.aTokens;
		lineSource = targetEntry.vLines;
	} else {
		tokenSource = entry.aTokens;
		lineSource = entry.vLines;
	}
	const tokens = tokenSource != null ? ` tokens="${tokenSource}"` : "";
	const summary =
		typeof attrs?.summary === "string"
			? ` summary="${attrs.summary.slice(0, 80)}"`
			: "";
	const query =
		typeof attrs?.query === "string" ? ` query="${attrs.query}"` : "";
	const command =
		typeof attrs?.command === "string" ? ` command="${attrs.command}"` : "";
	const target = attrs?.path ? ` target="${attrs.path}"` : "";
	// Slice reads emit lines="a-b/total"; others emit simple lines="N".
	const lines = isSlice
		? ` lines="${attrs.lineStart}-${attrs.lineEnd}/${attrs.totalLines}"`
		: lineSource != null
			? ` lines="${lineSource}"`
			: "";

	const attrStr = `${target}${status}${outcomeAttr}${query}${command}${summary}${lines}${tokens}`;

	if (entry.body) {
		return `<${action} path="${entry.path}"${attrStr}>${entry.body}</${action}>`;
	}
	return `<${action} path="${entry.path}"${attrStr}/>`;
}
