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
		const projectedBody = await hooks.tools.view(projectionKey, {
			path: row.path,
			scheme,
			body: row.body,
			attributes: attrs,
			visibility: row.visibility,
			category: row.category,
		});
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
			// Full-body token count, not projected. This is the cost to
			// promote the entry — the number the model needs to do Token
			// Budget math. Projecting the demoted symbol-preview (145
			// tokens for a 2108-token file) was misleading the model into
			// promotes that blew the Token Budget by 10-30× per entry.
			tokens: countTokens(row.body),
			attributes: row.attributes,
			category: row.category,
			source_turn: row.turn,
		});
	}
	const rows = await db.get_turn_context.all({ run_id: runId, turn });
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
