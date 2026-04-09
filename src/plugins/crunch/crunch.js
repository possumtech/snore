const SYSTEM_PROMPT =
	"Compress each entry to comma-separated searchable keywords (≤80 chars). " +
	"One line per entry. Format: N → keyword1,keyword2,keyword3";

const DEBUG = process.env.RUMMY_DEBUG === "true";

export default class Crunch {
	#core;

	constructor(core) {
		this.#core = core;
		core.on("cascade.summarize", this.#handleSummarize.bind(this));
	}

	async #handleSummarize({ entries, runId, store, contextSize, complete }) {
		if (!entries?.length || !complete || !store) return;

		const maxChars = contextSize ? Math.floor(contextSize * 0.5) : 50_000;
		const batches = batchEntries(entries, maxChars);

		console.warn(
			`[RUMMY] Crunch: ${entries.length} entries in ${batches.length} batch(es)`,
		);

		for (const batch of batches) {
			// Numbered index — LLM echoes back numbers, we map to paths
			const userLines = batch
				.map((e, i) => {
					const content = e.body || decodeURIComponent(e.path.replace(/^known:\/\//, ""));
					return `${i}: ${content.slice(0, 200)}`;
				})
				.join("\n");

			const messages = [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: userLines },
			];

			if (DEBUG) {
				console.warn(`[RUMMY] Crunch: batch of ${batch.length}, ${userLines.length} chars`);
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
				console.warn(`[RUMMY] Crunch response:\n${response}`);
			}

			const summaries = parseSummaries(response, batch);

			for (const { path, summary } of summaries) {
				await store.setAttributes(runId, path, { summary });
			}

			console.warn(
				`[RUMMY] Crunch: wrote ${summaries.length}/${batch.length} summaries`,
			);
		}
	}
}

export function batchEntries(entries, maxChars) {
	const batches = [];
	let current = [];
	let currentSize = 0;

	for (const entry of entries) {
		const content = entry.body || entry.path || "";
		const size = Math.min(content.length, 200) + 10;
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

	const results = [];

	for (const line of response.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Match: N → keywords  or  N -> keywords  or  N: keywords
		const match = trimmed.match(/^(\d+)\s*(?:→|->|:)\s*(.+)/);
		if (!match) continue;

		const index = Number.parseInt(match[1], 10);
		const summary = match[2].trim().slice(0, 80);

		if (!summary || index < 0 || index >= entries.length) continue;

		results.push({ path: entries[index].path, summary });
	}

	return results;
}
