/**
 * Dumps a run's complete exchange to a readable text file.
 * Called after every run completion when RUMMY_DEBUG=true.
 */
export default class RunDumper {
	static async dump(db, runId, outputPath) {
		const run = await db.get_run_by_id.get({ id: runId });
		if (!run) return;

		const entries = await db.get_known_entries.all({ run_id: runId });
		const turns = [
			...new Set(entries.filter((e) => e.turn > 0).map((e) => e.turn)),
		].sort((a, b) => a - b);

		const lines = [];
		lines.push(
			`=== RUN: ${run.alias} | status: ${run.status} | turns: ${run.next_turn - 1} ===`,
		);
		lines.push("");

		for (const turn of turns) {
			lines.push(`--- Turn ${turn} ---`);
			const turnEntries = entries.filter((e) => e.turn === turn);

			const system = turnEntries.find((e) => e.scheme === "system");
			if (system) {
				lines.push(`[system] ${system.body.length} chars`);
			}

			const user = turnEntries.find((e) => e.scheme === "user");
			if (user) {
				lines.push(`[user]`);
				lines.push(user.body);
			}

			const assistant = turnEntries.find((e) => e.scheme === "assistant");
			if (assistant) {
				lines.push(`[assistant]`);
				lines.push(assistant.body);
			}

			const model = turnEntries.find((e) => e.scheme === "model");
			if (model) {
				try {
					const data = JSON.parse(model.body);
					const usage = data.usage || {};
					lines.push(
						`[model] ${usage.prompt_tokens || 0} prompt / ${usage.completion_tokens || 0} completion tokens`,
					);
					if (data.reasoning_content) {
						lines.push(`[reasoning]`);
						lines.push(data.reasoning_content);
					}
				} catch {}
			}

			const others = turnEntries.filter(
				(e) =>
					![
						"system",
						"user",
						"assistant",
						"model",
						"prompt",
						"act",
						"ask",
						"progress",
					].includes(e.scheme),
			);
			for (const e of others) {
				const val = e.body ? ` ${e.body.slice(0, 200)}` : "";
				lines.push(`[${e.scheme}:${e.state}] ${e.path}${val}`);
			}

			const error = turnEntries.find((e) => e.scheme === "error");
			if (error) {
				lines.push(`[ERROR]`);
				lines.push(error.body);
			}

			lines.push("");
		}

		const { writeFile } = await import("node:fs/promises");
		await writeFile(outputPath, lines.join("\n"), "utf8");
		console.log(`[RUMMY] Run dump: ${outputPath}`);
	}
}
