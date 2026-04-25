import { stateToStatus } from "../../agent/httpStatus.js";

// Schemes whose log body is an action summary, not the cost-bearing
// content. For these, the action's cost lives on a separate data entry
// (sh/env: streaming channels; set/mv/cp: the target entry). Report
// tokens from the target when we can resolve it (set/mv/cp via
// attrs.path); omit entirely for sh/env (multiple channels, no single
// target to point at).
const STREAM_NO_TOKENS = new Set(["sh", "env"]);

export default class Log {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleLog.bind(this), 100);
	}

	async assembleLog(content, ctx) {
		// Log includes action entries (scheme=log) AND prior prompts. The
		// most recent prompt is rendered separately by the prompt plugin
		// as `<prompt>`; everything older lives in the log so the model
		// can see the full question history across a sustained run.
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

// Log paths are log://turn_N/action/slug. The second segment is the
// action — the plugin/tool that produced this log entry (set, get,
// search, update, error, etc.). Used as the XML tag name. Prompt
// entries live at prompt://N; they render as <prompt> in history.
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
	const status = statusValue != null ? ` status="${statusValue}"` : "";
	const outcomeAttr = entry.outcome ? ` outcome="${entry.outcome}"` : "";
	// `tokens=` is the promotion premium (aTokens) of the thing this tag
	// represents — what the model would free by demoting it. For actions
	// that reference a separate data entry (get/set/mv/cp), resolve via
	// attrs.path and report the target's aTokens. For actions whose log
	// body IS the cost-bearing content (search/update/error/ask_user,
	// plus <get> slice reads), use the log entry's own aTokens. sh/env
	// span multiple channel entries and are omitted — the channels
	// render their own tokens in <context>.
	const isSlice = attrs?.lineStart != null;
	const targetEntry = attrs?.path ? rowsByPath.get(attrs.path) : null;
	let tokenSource = null;
	if (STREAM_NO_TOKENS.has(action)) tokenSource = null;
	else if (isSlice) tokenSource = entry.aTokens;
	else if (targetEntry) tokenSource = targetEntry.aTokens;
	else tokenSource = entry.aTokens;
	const tokens = tokenSource != null ? ` tokens="${tokenSource}"` : "";
	const summary =
		typeof attrs?.summary === "string"
			? ` summary="${attrs.summary.slice(0, 80)}"`
			: "";
	const query =
		typeof attrs?.query === "string" ? ` query="${attrs.query}"` : "";
	const command =
		typeof attrs?.command === "string" ? ` command="${attrs.command}"` : "";
	// target= is the path the action touched (e.g. the file/known that was
	// set, the URL that was fetched). Plugins store it in attrs.path when
	// they write the log entry.
	const target = attrs?.path ? ` target="${attrs.path}"` : "";
	// Slice reads tag the log entry with lineStart/lineEnd/totalLines so
	// the <get> tag surfaces `lines="a-b/total"` — a concrete handle for
	// the model to re-issue or compare against another slice.
	const lines = isSlice
		? ` lines="${attrs.lineStart}-${attrs.lineEnd}/${attrs.totalLines}"`
		: "";

	const attrStr = `${target}${status}${outcomeAttr}${query}${command}${summary}${lines}${tokens}`;

	if (entry.body) {
		return `<${action} path="${entry.path}"${attrStr}>${entry.body}</${action}>`;
	}
	return `<${action} path="${entry.path}"${attrStr}/>`;
}
