const SYSTEM_PROMPT =
	"Compress each entry to ≤80 characters of searchable keywords. " +
	"No sentences. No filler. One line per entry: path → keywords";

const DEBUG = process.env.RUMMY_DEBUG === "true";

export default class Crunch {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("cascade.summarize", this.#handleSummarize.bind(this));
	}

	async #handleSummarize({ entries, runId, store, contextSize, complete }) {
		if (!entries?.length || !complete || !store) return;

		const maxChars = contextSize ? Math.floor(contextSize * 3) : 100_000;
		const batches = batchEntries(entries, maxChars);

		for (const batch of batches) {
			const userLines = batch
				.map((e) => `<entry path="${e.path}">${e.body || ""}</entry>`)
				.join("\n");

			const messages = [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: userLines },
			];

			if (DEBUG) {
				console.warn(`[RUMMY] Crunch: summarizing ${batch.length} entries`);
			}

			let response;
			try {
				const result = await complete(messages);
				response = result?.choices?.[0]?.message?.content ?? "";
			} catch (err) {
				console.warn(`[RUMMY] Crunch: summarization failed: ${err.message}`);
				continue;
			}

			if (DEBUG) {
				console.warn(`[RUMMY] Crunch: response:\n${response}`);
			}

			const summaries = parseSummaries(response, batch);

			for (const { path, summary } of summaries) {
				await store.setAttributes(runId, path, { summary });
				if (DEBUG) {
					console.warn(`[RUMMY] Crunch: wrote summary for ${path}: ${summary}`);
				}
			}
		}
	}
}

export function batchEntries(entries, maxChars) {
	const batches = [];
	let current = [];
	let currentSize = 0;

	for (const entry of entries) {
		const size = (entry.path?.length ?? 0) + (entry.body?.length ?? 0) + 30;
		if (currentSize + size > maxChars && current.length > 0) {
			batches.push(current);
			current = [];
			currentSize = 0;
		}
		current.push(entry);
		currentSize += size;
	}
	if (current.length > 0) batches.push(current);
	return batches;
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
