export default class Engine {
	static register(hooks) {
		hooks.onTurn(async (rummy) => {
			if (rummy.noContext) return;
			if (!rummy.contextSize) return;

			const { runId, sequence, store, db } = rummy;

			const { total } = await db.get_promoted_token_total.get({
				run_id: runId,
			});
			if (total <= rummy.contextSize) return;

			const entries = await db.get_promoted_entries.all({ run_id: runId });
			const demoted = await enforce(
				db,
				store,
				runId,
				sequence,
				rummy.contextSize,
				total,
				entries,
			);

			if (demoted.length > 0) {
				const saved = demoted.reduce((s, d) => s + d.saved, 0);
				const before = ((total / rummy.contextSize) * 100) | 0;
				const after = (((total - saved) / rummy.contextSize) * 100) | 0;
				const names = demoted.map((d) => d.path).join(", ");
				const resultPath = await store.nextResultPath(runId, "inject");
				await store.upsert(
					runId,
					sequence,
					resultPath,
					`engine demoted: ${names} (budget: ${before}% → ${after}%)`,
					"info",
					{},
				);
			}
		}, 20);
	}
}

const TIERS = ["result", "file_full", "known", "file_symbols", "file_path"];

function classify(entry) {
	if (
		entry.scheme !== null &&
		entry.scheme !== "known" &&
		entry.scheme !== "unknown"
	)
		return "result";
	if (entry.scheme === null && entry.state !== "symbols") return "file_full";
	if (entry.scheme === "known") return "known";
	if (entry.scheme === null && entry.state === "symbols") return "file_symbols";
	return "file_path";
}

function compareDemotion(a, b) {
	const ta = TIERS.indexOf(classify(a));
	const tb = TIERS.indexOf(classify(b));
	if (ta !== tb) return ta - tb;
	if (a.turn !== b.turn) return a.turn - b.turn;
	if (a.refs !== b.refs) return a.refs - b.refs;
	return b.tokens - a.tokens;
}

async function enforce(db, store, runId, currentTurn, budget, total, entries) {
	const candidates = entries
		.filter((e) => e.turn !== currentTurn)
		.toSorted(compareDemotion);

	const demoted = [];
	let remaining = total;

	for (const entry of candidates) {
		if (remaining <= budget) break;

		const tier = classify(entry);

		if (tier === "file_full") {
			await db.downgrade_file_to_symbols.run({
				run_id: runId,
				path: entry.path,
			});
			const meta = await store.getMeta(runId, entry.path);
			const symbolsLen = meta?.symbols?.length ?? 0;
			const symbolsTokens = (symbolsLen / 4) | 0;
			const saved = entry.tokens - symbolsTokens;
			remaining -= saved;
			demoted.push({ path: entry.path, saved });
			continue;
		}

		await store.demote(runId, entry.path);
		remaining -= entry.tokens;
		demoted.push({ path: entry.path, saved: entry.tokens });
	}

	return demoted;
}
