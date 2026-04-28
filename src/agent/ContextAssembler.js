// Orchestrates assembly.system / assembly.user filter chains; plugins do all rendering.
export default class ContextAssembler {
	static async assembleFromTurnContext(
		rows,
		{
			type = "ask",
			systemPrompt = "",
			contextSize = 0,
			toolSet = null,
			lastContextTokens = 0,
			turn = 1,
		} = {},
		hooks,
	) {
		// Loop boundary from active prompt; absent on turn 1 before prompt plugin's turn.started.
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
