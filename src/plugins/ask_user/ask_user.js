import docs from "./ask_userDoc.js";

export default class AskUser {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme();
		core.on("handler", this.handler.bind(this));
		core.on("promoted", this.full.bind(this));
		core.on("demoted", this.summary.bind(this));
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

		await store.upsert(runId, turn, entry.resultPath, entry.body, "proposed", {
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
