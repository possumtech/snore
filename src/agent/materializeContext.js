import ContextAssembler from "./ContextAssembler.js";
import { countTokens } from "./tokens.js";

/**
 * Rebuild turn_context from v_model_context, then assemble messages.
 * Called at turn start and again by the budget plugin when it needs a
 * fresh measurement after mutating visibility.
 */
export default async function materializeContext({
	db,
	hooks,
	runId,
	loopId,
	turn,
	systemPrompt,
	mode,
	toolSet,
	contextSize,
	demoted,
}) {
	await db.clear_turn_context.run({ run_id: runId, turn });
	const viewRows = await db.get_model_context.all({ run_id: runId });
	// Per-entry token accounting (see SPEC @token_accounting): captured
	// here while we still have the raw body, then merged onto rows after
	// the read-back roundtrip through turn_context.
	const tokenAccounting = new Map();
	for (const row of viewRows) {
		// schemeOf() yields NULL (or "") for bare file paths — translate
		// to "file" so the view lookup finds the file scheme handler.
		const scheme = row.scheme ? row.scheme : "file";
		const attrs = row.attributes ? JSON.parse(row.attributes) : null;
		// Log entries live at log://turn_N/action/slug. Dispatch projection
		// to the action plugin's view (set, update, search, etc.) by
		// extracting the action segment from the path.
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
		const summarizedProjection = await hooks.tools.view(projectionKey, {
			...baseEntry,
			visibility: "summarized",
		});
		const vTokens = countTokens(visibleProjection);
		const sTokens = countTokens(summarizedProjection);
		tokenAccounting.set(row.path, { vTokens, sTokens });
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
			tokens: countTokens(row.body),
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
	}
	const lastCtx = await db.get_last_context_tokens.get({ run_id: runId });
	// First turn of a new run has no prior context.
	let lastContextTokens = 0;
	if (lastCtx) lastContextTokens = lastCtx.context_tokens;

	const messages = await ContextAssembler.assembleFromTurnContext(
		rows,
		{
			type: mode,
			systemPrompt,
			contextSize,
			demoted,
			toolSet,
			lastContextTokens,
			turn,
		},
		hooks,
	);
	return { rows, messages, lastContextTokens };
}
