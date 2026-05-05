import { stateToStatus } from "../../agent/httpStatus.js";
import { renderEntry } from "../helpers.js";

// sh/env span multiple channels; channels render their own tokens in <visible>.
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

	const meta = { action };
	if (attrs?.path) meta.target = attrs.path;
	// Suppress status on prompts; uniform 200 carries no signal.
	if (statusValue != null && action !== "prompt") meta.status = statusValue;
	if (entry.outcome) meta.outcome = entry.outcome;
	if (typeof attrs?.query === "string") meta.query = attrs.query;
	if (typeof attrs?.command === "string") meta.command = attrs.command;
	if (typeof attrs?.summary === "string")
		meta.summary = attrs.summary.slice(0, 80);
	if (isSlice) {
		meta.lines = `${attrs.lineStart}-${attrs.lineEnd}/${attrs.totalLines}`;
	} else if (lineSource != null) {
		meta.lines = lineSource;
	}
	if (tokenSource != null) meta.tokens = tokenSource;

	return renderEntry(entry.path, meta, entry.body);
}
