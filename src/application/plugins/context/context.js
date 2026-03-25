export default class ContextPlugin {
	static register(hooks) {
		hooks.onTurn(async (rummy) => {
			const { db } = rummy;
			if (!rummy.runId) return;

			const pending = await db.get_pending_context.all({
				run_id: rummy.runId,
			});
			if (pending.length === 0) return;

			for (const row of pending) {
				let el;
				if (row.type === "diff") {
					// <info file="path">edits accepted</info>
					// <warn file="path">edits rejected</warn>
					const tagName =
						row.result.includes("rejected") || row.result.includes("partially")
							? "warn"
							: "info";
					el = rummy.tag(tagName, { file: row.request }, [row.result]);
				} else if (row.type === "notification") {
					el = rummy.tag("info", { prompt: row.request }, [row.result]);
				} else {
					// command / env
					const tagName = row.is_error ? "error" : "info";
					const attrs = { command: row.request, type: row.type };
					el = rummy.tag(tagName, attrs, [row.result]);
				}
				rummy.contextEl.appendChild(el);

				if (rummy.turnId) {
					await db.consume_pending_context.run({
						id: row.id,
						turn_id: rummy.turnId,
					});
				}
			}
		}, 5);
	}
}
