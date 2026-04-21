import { stateToStatus } from "../../agent/httpStatus.js";

const NO_TOKENS_SCHEMES = new Set(["set", "mv", "cp", "sh", "env"]);

export default class Log {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.user", this.assembleLog.bind(this), 100);
	}

	async assembleLog(content, ctx) {
		const entries = ctx.rows.filter(
			(r) => r.category === "logging" && r.scheme === "log",
		);
		if (entries.length === 0) return content;
		const lines = entries.map((e) => renderLogTag(e));
		return `${content}<log>\n${lines.join("\n")}\n</log>\n`;
	}
}

// Log paths are log://turn_N/action/slug. The second segment is the
// action — the plugin/tool that produced this log entry (set, get,
// search, update, error, etc.). Used as the XML tag name.
function actionFromPath(path) {
	const match = path?.match(/^log:\/\/turn_\d+\/([^/]+)\//);
	return match ? match[1] : "log";
}

function renderLogTag(entry) {
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
	const tokens =
		entry.tokens && !NO_TOKENS_SCHEMES.has(action)
			? ` tokens="${entry.tokens}"`
			: "";
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

	const attrStr = `${target}${status}${outcomeAttr}${query}${command}${summary}${tokens}`;

	if (entry.body) {
		return `<${action} path="${entry.path}"${attrStr}>${entry.body}</${action}>`;
	}
	return `<${action} path="${entry.path}"${attrStr}/>`;
}
