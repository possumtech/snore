import { readFileSync } from "node:fs";

export default class AskUser {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("full", this.full.bind(this));
		core.on("summary", this.summary.bind(this));
		const docs = readFileSync(new URL("./docs.md", import.meta.url), "utf8");
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.ask_user = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const { entries: store, sequence: turn, runId, loopId } = rummy;
		const { question, options: rawOptions } = entry.attributes;

		const optionText = rawOptions || entry.body || "";
		const delimiter = optionText.includes(";") ? ";" : ",";
		const options = optionText
			? optionText
					.split(delimiter)
					.map((o) => o.trim())
					.filter(Boolean)
			: [];

		await store.upsert(runId, turn, entry.resultPath, entry.body, 202, {
			attributes: { question, options },
			loopId,
		});
	}

	full(entry) {
		const { question, answer } = entry.attributes;
		const lines = ["# ask_user"];
		if (question) lines.push(`# Question: ${question}`);
		if (answer) lines.push(`# Answer: ${answer}`);
		return lines.join("\n");
	}

	summary(entry) {
		const { question, answer } = entry.attributes;
		return answer ? `${question} → ${answer}` : question || "";
	}
}
