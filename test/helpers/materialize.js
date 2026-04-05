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
			turn,
			ordinal: 0,
			path: "system://prompt",
			fidelity: "full",
			state: "info",
			body: systemPrompt,
			tokens: countTokens(systemPrompt),
			attributes: null,
			category: "system",
		});
	}

	const rows = await db.get_model_context.all({ run_id: runId });
	for (const row of rows) {
		await db.insert_turn_context.run({
			run_id: runId,
			turn,
			ordinal: row.ordinal,
			path: row.path,
			fidelity: row.fidelity,
			state: row.state,
			body: row.body,
			tokens: row.tokens,
			attributes: row.attributes,
			category: row.category,
			source_turn: row.turn,
		});
	}
}
