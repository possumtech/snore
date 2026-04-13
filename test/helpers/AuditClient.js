import RpcClient from "./RpcClient.js";

/**
 * AuditClient wraps RpcClient with per-run audit tracking.
 * Dumps the SPECIFIC failing run's K/V state on assertion failure.
 */
export default class AuditClient extends RpcClient {
	#db;
	#currentRun = null;

	constructor(url, db) {
		super(url);
		this.#db = db;
		this.#setupAutoResolve();
	}

	#setupAutoResolve() {
		this.on("run/proposal", async ({ run, proposed }) => {
			for (const p of proposed || []) {
				try {
					await this.call("run/resolve", {
						run,
						resolution: {
							path: p.path,
							action: "accept",
							output: p.path?.startsWith("ask_user://") ? "N/A" : "",
						},
					});
				} catch {}
			}
		});
	}

	async call(method, params = {}) {
		const result = await super.call(method, params);

		if ((method === "ask" || method === "act") && result?.run) {
			this.#currentRun = result.run;
		}

		return result;
	}

	/**
	 * Dump audit for a specific run alias.
	 */
	async dumpRun(alias) {
		const runRow = await this.#db.get_run_by_alias.get({ alias });
		if (!runRow) {
			console.log(`\n=== AUDIT: ${alias} — NOT FOUND ===\n`);
			return;
		}

		const entries = await this.#db.get_known_entries.all({ run_id: runRow.id });
		const turns = [...new Set(entries.map((e) => e.turn))].sort(
			(a, b) => a - b,
		);

		console.log(
			`\n=== AUDIT: ${alias} (${runRow.status}, ${entries.length} entries) ===`,
		);
		for (const t of turns) {
			const turnEntries = entries.filter((e) => e.turn === t);
			console.log(`\n  Turn ${t}:`);
			for (const e of turnEntries) {
				const attrs = e.attributes ? JSON.parse(e.attributes) : null;
				const val = (e.body || "").slice(0, 120).replace(/\n/g, "\\n");
				const attrsStr = attrs ? ` ${JSON.stringify(attrs).slice(0, 60)}` : "";
				console.log(`    ${e.scheme}:${e.state} ${e.path}${attrsStr}`);
				if (val) console.log(`      ${val}`);
			}
		}
		console.log(`\n=== END ${alias} ===\n`);
	}

	/**
	 * Assert run result. Dumps the SPECIFIC run on failure.
	 */
	async assertRun(result, validStatuses, label) {
		const statuses = Array.isArray(validStatuses)
			? validStatuses
			: [validStatuses];
		if (!statuses.includes(result.status)) {
			await this.dumpRun(result.run);
			throw new Error(
				`${label}: expected ${statuses.join("|")}, got ${result.status} (run: ${result.run})`,
			);
		}
	}
}
