import { SUMMARY_MAX_CHARS } from "../plugins/helpers.js";
import ContextAssembler from "./ContextAssembler.js";
import { countLines, countTokens } from "./tokens.js";

// Defensive cap: every plugin's `summarized` projection must produce
// ≤ SUMMARY_MAX_CHARS (the contract floor). When a plugin breaks the
// contract the cap truncates and emits an error so engineers can fix
// the plugin. Hitting this should be a bug report, not steady-state.

// Rebuild turn_context from v_model_context and assemble messages.
export default async function materializeContext({
	db,
	hooks,
	entries,
	runId,
	loopId,
	turn,
	systemPrompt,
	mode,
	toolSet,
	contextSize,
}) {
	await db.clear_turn_context.run({ run_id: runId, turn });
	const viewRows = await db.get_model_context.all({ run_id: runId });
	// Per-entry token accounting; merged back after the turn_context roundtrip.
	const tokenAccounting = new Map();
	for (const row of viewRows) {
		const scheme = row.scheme ? row.scheme : "file";
		const attrs = row.attributes ? JSON.parse(row.attributes) : null;
		// Dispatch log entries to their action plugin's view via path segment.
		let projectionKey = scheme;
		if (scheme === "log") {
			const m = row.path.match(/^log:\/\/turn_\d+\/([^/]+)\//);
			if (m) projectionKey = m[1];
		}
		const baseEntry = {
			path: row.path,
			scheme,
			body: row.body,
			attributes: attrs,
			category: row.category,
		};
		const visibleProjection = await hooks.tools.view(projectionKey, {
			...baseEntry,
			visibility: "visible",
		});
		const rawSummarizedProjection = await hooks.tools.view(projectionKey, {
			...baseEntry,
			visibility: "summarized",
		});
		let summarizedProjection = rawSummarizedProjection;
		if (
			typeof summarizedProjection === "string" &&
			summarizedProjection.length > SUMMARY_MAX_CHARS
		) {
			summarizedProjection = summarizedProjection.slice(0, SUMMARY_MAX_CHARS);
			await hooks.error.log.emit({
				store: entries,
				runId,
				turn,
				loopId,
				message: `${row.path} summarized projection overflow`,
				soft: true,
			});
		}
		const vTokens = countTokens(visibleProjection);
		const sTokens = countTokens(summarizedProjection);
		const vLines = countLines(visibleProjection);
		tokenAccounting.set(row.path, {
			vTokens,
			sTokens,
			vLines,
			vBody: visibleProjection,
			sBody: summarizedProjection,
		});
		const projectedBody =
			row.visibility === "visible" ? visibleProjection : summarizedProjection;
		await db.insert_turn_context.run({
			run_id: runId,
			loop_id: loopId,
			turn,
			ordinal: row.ordinal,
			path: row.path,
			visibility: row.visibility,
			state: row.state,
			outcome: row.outcome,
			body: projectedBody,
			attributes: row.attributes,
			category: row.category,
			source_turn: row.turn,
		});
	}
	const rows = await db.get_turn_context.all({ run_id: runId, turn });
	for (const row of rows) {
		const t = tokenAccounting.get(row.path);
		if (!t) continue;
		row.vTokens = t.vTokens;
		row.sTokens = t.sTokens;
		row.aTokens = t.vTokens - t.sTokens;
		row.vLines = t.vLines;
		row.vBody = t.vBody;
		row.sBody = t.sBody;
	}
	const lastCtx = await db.get_last_context_tokens.get({ run_id: runId });
	let lastContextTokens = 0;
	if (lastCtx) lastContextTokens = lastCtx.context_tokens;

	const messages = await ContextAssembler.assembleFromTurnContext(
		rows,
		{
			type: mode,
			systemPrompt,
			contextSize,
			toolSet,
			lastContextTokens,
			turn,
		},
		hooks,
	);
	return { rows, messages, lastContextTokens };
}
