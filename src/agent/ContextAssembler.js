/**
 * Thin orchestrator. Computes loopStartTurn from the rows,
 * then invokes assembly.system and assembly.user filter chains.
 * All rendering logic lives in plugins.
 */
export default class ContextAssembler {
	static async assembleFromTurnContext(
		rows,
		{
			type = "ask",
			systemPrompt = "",
			contextSize = 0,
			demoted = [],
			noInteraction = false,
		} = {},
		hooks,
	) {
		// Find loop boundary from active prompt
		const promptEntry = rows.findLast(
			(r) =>
				r.category === "prompt" && (r.scheme === "ask" || r.scheme === "act"),
		);
		const loopStartTurn = promptEntry?.source_turn ?? 0;

		const ctx = {
			rows,
			loopStartTurn,
			type,
			contextSize,
			demoted,
			noInteraction,
		};

		const system = await hooks.assembly.system.filter(systemPrompt, ctx);
		const user = await hooks.assembly.user.filter("", ctx);

		return [
			{ role: "system", content: system },
			{ role: "user", content: user },
		];
	}
}
