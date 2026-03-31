import { countTokens } from "../../agent/tokens.js";

export default class Engine {
	static register(hooks) {
		hooks.onTurn(async (rummy) => {
			if (rummy.noContext) return;
			if (!rummy.contextSize) return;

			const { runId, sequence, store, db } = rummy;

			// Budget enforcement — demote from known_entries if over budget
			const { total } = await db.get_promoted_token_total.get({
				run_id: runId,
			});
			if (total > rummy.contextSize) {
				const entries = await db.get_promoted_entries.all({
					run_id: runId,
				});
				const demoted = await enforce(
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
			}

			// Materialize turn_context from post-enforcement known_entries
			await materialize(
				db,
				runId,
				sequence,
				rummy.systemPrompt,
				rummy.loopPrompt,
			);
		}, 20);
	}
}

// --- Budget enforcement ---

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

async function enforce(store, runId, currentTurn, budget, total, entries) {
	const candidates = entries
		.filter((e) => e.turn !== currentTurn)
		.toSorted(compareDemotion);

	const demoted = [];
	let remaining = total;

	for (const entry of candidates) {
		if (remaining <= budget) break;

		const tier = classify(entry);

		if (tier === "file_full") {
			const before = entry.tokens;
			await store.setFileState(runId, entry.path, "symbols");
			const meta = await store.getMeta(runId, entry.path);
			const symbolsTokens = ((meta?.symbols?.length ?? 0) / 4) | 0;
			const saved = before - symbolsTokens;
			remaining -= saved;
			demoted.push({ path: entry.path, saved });
			continue;
		}

		remaining -= entry.tokens;
		await store.demote(runId, entry.path);
		demoted.push({ path: entry.path, saved: entry.tokens });
	}

	return demoted;
}

// --- Materialization ---

function schemeOf(path) {
	const idx = path.indexOf("://");
	return idx > 0 ? path.slice(0, idx) : null;
}

async function materialize(db, runId, turn, systemPrompt, loopPrompt) {
	await db.clear_turn_context.run({ run_id: runId, turn });

	let ordinal = 0;

	const insert = (path, bucket, content, meta = null) => {
		const tokens = countTokens(content);
		return db.insert_turn_context.run({
			run_id: runId,
			turn,
			ordinal: ordinal++,
			path,
			bucket,
			content,
			tokens,
			meta: meta ? JSON.stringify(meta) : null,
		});
	};

	// 0. System prompt
	if (systemPrompt) {
		await insert("system://prompt", "system", systemPrompt);
	}

	// 1. Active known
	for (const r of await db.get_active_known.all({ run_id: runId })) {
		await insert(r.path, "known", r.value);
	}

	// 2. Stored known
	for (const r of await db.get_stored_known.all({ run_id: runId })) {
		await insert(r.path, "stored", "");
	}

	// 3. Stored file paths
	for (const r of await db.get_stored_files.all({ run_id: runId })) {
		await insert(r.path, "file:path", "");
	}

	// 4. Symbol files
	for (const r of await db.get_symbol_files.all({ run_id: runId })) {
		const meta = r.meta ? JSON.parse(r.meta) : null;
		await insert(r.path, "file:symbols", meta?.symbols || "");
	}

	// 5. Full files
	for (const r of await db.get_full_files.all({ run_id: runId })) {
		const fileState =
			r.state === "readonly"
				? "file:readonly"
				: r.state === "active"
					? "file:active"
					: "file";
		await insert(r.path, "file", r.value, {
			state: fileState,
			tokens_full: r.tokens,
		});
	}

	// 6. Chronological results
	for (const r of await db.get_results.all({ run_id: runId })) {
		const tool = schemeOf(r.path);
		const rmeta = r.meta ? JSON.parse(r.meta) : {};
		const target =
			rmeta.command || rmeta.file || rmeta.path || rmeta.question || "";

		let value = "";
		if (r.state === "summary") value = r.value;
		else if (tool === "env" || tool === "run" || tool === "ask_user")
			value = r.value;
		else if (tool === "edit" && rmeta.blocks?.length > 0)
			value = rmeta.blocks
				.map((b) =>
					b.search === null
						? `+++ ${b.replace?.slice(0, 200)}`
						: `--- ${b.search?.slice(0, 100)}\n+++ ${b.replace?.slice(0, 200)}`,
				)
				.join("\n");

		await insert(r.path, "result", value, {
			tool: tool || r.state,
			target,
			state: r.state,
		});
	}

	// 7. Unknowns
	for (const r of await db.get_unknowns.all({ run_id: runId })) {
		await insert(r.path, "unknown", r.value);
	}

	// 8. Prompt / continuation
	const prompt = await db.get_latest_prompt.get({ run_id: runId });
	if (prompt) {
		await insert(prompt.path, "prompt", prompt.value);
	} else if (loopPrompt) {
		await insert("continuation://prompt", "continuation", loopPrompt);
	}
}
