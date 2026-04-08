const SYSTEM_PROMPT =
	"Compress each entry to ≤80 characters of searchable keywords. " +
	"No sentences. No filler. One line per entry: path → keywords";

const DEBUG = process.env.RUMMY_DEBUG === "true";

export default class Crunch {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("cascade.summarize", this.#handleSummarize.bind(this));
		console.warn("[RUMMY] Crunch plugin registered");
	}

	async #handleSummarize({ entries, runId, model, complete }) {
		if (!entries?.length || !complete) return;

		const store = this.#core.entries;
		if (!store) return;

		const userLines = entries
			.map((e) => `<entry path="${e.path}">${e.body}</entry>`)
			.join("\n");

		const messages = [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: userLines },
		];

		if (DEBUG) {
			console.warn(`[RUMMY] Crunch: summarizing ${entries.length} entries`);
			console.warn(`[RUMMY] Crunch: prompt:\n${userLines}`);
		}

		let response;
		try {
			const result = await complete(messages);
			response = result?.choices?.[0]?.message?.content ?? "";
		} catch (err) {
			console.warn(`[RUMMY] Crunch: summarization failed: ${err.message}\n${err.stack}`);
			return;
		}

		if (DEBUG) {
			console.warn(`[RUMMY] Crunch: response:\n${response}`);
		}

		const summaries = parseSummaries(response, entries);

		for (const { path, summary } of summaries) {
			await store.setAttributes(runId, path, { summary });
			if (DEBUG) {
				console.warn(`[RUMMY] Crunch: wrote summary for ${path}: ${summary}`);
			}
		}
	}
}

export function parseSummaries(response, entries) {
	if (!response) return [];

	const pathSet = new Set(entries.map((e) => e.path));
	const results = [];

	for (const line of response.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const sep = trimmed.indexOf(" → ");
		if (sep === -1) continue;

		const path = trimmed.slice(0, sep).trim();
		const summary = trimmed
			.slice(sep + 3)
			.trim()
			.slice(0, 80);

		if (!summary) continue;
		if (!pathSet.has(path)) continue;

		results.push({ path, summary });
	}

	return results;
}
