import { countTokens } from "../../src/agent/tokens.js";

/**
 * Materialize turn_context for a run/turn.
 * Queries v_model_context VIEW and inserts rows directly.
 * No projection functions — for integration tests only.
 */
export default async function materialize(
	db,
	{ runId, turn, systemPrompt = "test" },
) {
	await db.clear_turn_context.run({ run_id: runId, turn });

	if (systemPrompt) {
		await db.insert_turn_context.run({
			run_id: runId,
			loop_id: null,
			turn,
			ordinal: 0,
			path: "system://prompt",
			visibility: "visible",
			state: "resolved",
			body: systemPrompt,
			tokens: countTokens(systemPrompt),
			attributes: null,
			category: "system",
		});
	}

	const rows = await db.get_model_context.all({ run_id: runId });
	for (const row of rows) {
		// tokens from the view reflect the projected body cost (visibility-aware)
		await db.insert_turn_context.run({
			run_id: runId,
			loop_id: null,
			turn,
			ordinal: row.ordinal,
			path: row.path,
			visibility: row.visibility,
			state: row.state,
			outcome: row.outcome,
			body: row.body,
			tokens: countTokens(row.body),
			attributes: row.attributes,
			category: row.category,
			source_turn: row.turn,
		});
	}
}
