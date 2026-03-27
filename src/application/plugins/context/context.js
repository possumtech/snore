export default class ContextPlugin {
	static register(hooks) {
		hooks.onTurn(async (rummy) => {
			const { db } = rummy;
			if (!rummy.runId) return;

			const pending = await db.get_pending_context.all({
				run_id: rummy.runId,
			});
			if (pending.length === 0) return;

			const lines = [];
			for (const row of pending) {
				if (row.type === "diff") {
					const level =
						row.result.includes("rejected") ||
						row.result.includes("partially")
							? "warn"
							: "info";
					lines.push(`${level}: ${row.request} # ${row.result}`);
				} else if (row.type === "notification") {
					lines.push(`info: ${row.request} # ${row.result}`);
				} else {
					const level = row.is_error ? "error" : "info";
					lines.push(`${level}: ${row.request} # ${row.result}`);
				}

				if (rummy.turnId) {
					await db.consume_pending_context.run({
						id: row.id,
						turn_id: rummy.turnId,
					});
				}
			}

			if (lines.length > 0) {
				const feedbackEl = rummy.tag("feedback", {}, [lines.join("\n")]);
				rummy.contextEl.appendChild(feedbackEl);
			}
		}, 5);
	}
}
