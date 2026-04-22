export default class Protocol {
	#core;
	#loopState = new Map();

	constructor(core) {
		this.#core = core;
		core.filter("entry.recording", this.#onRecording.bind(this), 1);
		core.hooks.loop.started.on(this.#onLoopStarted.bind(this));
		core.hooks.loop.completed.on(this.#onLoopCompleted.bind(this));
		core.hooks.turn.started.on(this.#onTurnStarted.bind(this));
	}

	#onLoopStarted({ loopId }) {
		this.#loopState.set(loopId, { turnUpdateCount: 0, maxStatus: 0 });
	}

	#onLoopCompleted({ loopId }) {
		this.#loopState.delete(loopId);
	}

	#onTurnStarted({ rummy }) {
		const state = this.#loopState.get(rummy.loopId);
		state.turnUpdateCount = 0;
	}

	async #onRecording(entry, ctx) {
		if (entry.scheme !== "update") return entry;
		const state = this.#loopState.get(ctx.loopId);

		state.turnUpdateCount++;
		if (state.turnUpdateCount > 1) {
			await this.#core.hooks.error.log.emit({
				store: ctx.store,
				runId: ctx.runId,
				turn: ctx.turn,
				loopId: ctx.loopId,
				message: "Protocol Violation: Multiple steps in turn",
				status: 422,
			});
		}

		const status = entry.attributes?.status ?? 102;
		if (status > state.maxStatus + 1) {
			await this.#core.hooks.error.log.emit({
				store: ctx.store,
				runId: ctx.runId,
				turn: ctx.turn,
				loopId: ctx.loopId,
				message: "Protocol Violation: Steps skipped",
				status: 422,
			});
		}
		if (status > state.maxStatus) state.maxStatus = status;

		return entry;
	}
}
