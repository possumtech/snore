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
			toolSet = null,
			lastContextTokens = 0,
			turn = 1,
		} = {},
		hooks,
	) {
		// Find loop boundary from active prompt. Absent on turn 1 before
		// the prompt plugin's turn.started handler has run.
		const promptEntry = rows.findLast(
			(r) => r.category === "prompt" && r.scheme === "prompt",
		);
		let loopStartTurn = 0;
		if (promptEntry) loopStartTurn = promptEntry.source_turn;

		const ctx = {
			rows,
			loopStartTurn,
			type,
			contextSize,
			lastContextTokens,
			demoted,
			toolSet,
			turn,
		};

		const system = await hooks.assembly.system.filter(systemPrompt, ctx);
		const user = await hooks.assembly.user.filter("", ctx);

		return [
			{ role: "system", content: system },
			{ role: "user", content: user },
		];
	}
}
