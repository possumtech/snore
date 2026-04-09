export default class Previous {
	#core;

	constructor(core) {
		this.#core = core;
		core.filter("assembly.system", this.assemblePrevious.bind(this), 200);
	}

	async assemblePrevious(content, ctx) {
		if (ctx.loopStartTurn <= 1) return content;

		const entries = ctx.rows.filter(
			(r) =>
				(r.category === "logging" || r.category === "prompt") &&
				r.source_turn < ctx.loopStartTurn,
		);
		if (entries.length === 0) return content;

		const lines = await Promise.all(
			entries.map((e) => renderToolTag(e, this.#core)),
		);
		return `${content}\n\n<previous>\n${lines.join("\n")}\n</previous>`;
	}
}

async function renderToolTag(entry, core) {
	const attrs =
		typeof entry.attributes === "string"
			? JSON.parse(entry.attributes)
			: entry.attributes;

	const target = attrs?.path || attrs?.file || attrs?.command || "";
	const status = entry.status ? ` status="${entry.status}"` : "";
	const summary =
		typeof attrs?.summary === "string"
			? ` summary="${attrs.summary.slice(0, 80)}"`
			: "";

	let body;
	try {
		body = await core.hooks.tools.view(entry.scheme, {
			...entry,
			attributes: attrs,
		});
	} catch {
		body = entry.body;
	}

	if (body) {
		return `<${entry.scheme} path="${target}"${status}${summary}>${body}</${entry.scheme}>`;
	}
	return `<${entry.scheme} path="${target}"${status}${summary}/>`;
}
