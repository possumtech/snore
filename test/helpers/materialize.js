import { countTokens } from "../../src/agent/tokens.js";

/**
 * Materialize turn_context for a run/turn, same as TurnExecutor does.
 * Use in integration tests that need turn_context populated.
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
			body: systemPrompt,
			tokens: countTokens(systemPrompt),
			attributes: null,
			category: "system",
		});
	}

	await db.materialize_turn_context.run({ run_id: runId, turn });
}
