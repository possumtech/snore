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
				(r.category === "result" ||
					r.category === "structural" ||
					r.category === "prompt") &&
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

	const path = `${entry.scheme}://${attrs?.path || attrs?.file || attrs?.command || ""}`;
	const status = entry.status ? ` status="${entry.status}"` : "";

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
		return `<tool path="${path}"${status}>${body}</tool>`;
	}
	return `<tool path="${path}"${status}/>`;
}
