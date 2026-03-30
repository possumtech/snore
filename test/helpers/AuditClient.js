import RpcClient from "./RpcClient.js";

/**
 * AuditClient wraps RpcClient with automatic run tracking and
 * audit dump on failure. Every E2E test uses this instead of RpcClient.
 */
export default class AuditClient extends RpcClient {
	#db;
	#runs = [];

	constructor(url, db) {
		super(url);
		this.#db = db;
	}

	async call(method, params = {}) {
		const result = await super.call(method, params);

		// Track runs from ask/act calls
		if ((method === "ask" || method === "act") && result?.run) {
			this.#runs.push(result.run);
		}

		return result;
	}

	/**
	 * Dump the full audit for all runs in this test.
	 * Call this in a test's catch block or after block on failure.
	 */
	async dumpAudit(label = "AUDIT") {
		for (const alias of this.#runs) {
			const runRow = await this.#db.get_run_by_alias.get({ alias });
			if (!runRow) continue;

			const entries = await this.#db.get_known_entries.all({ run_id: runRow.id });
			const turns = [...new Set(entries.map((e) => e.turn))].sort((a, b) => a - b);

			console.log(`\n=== ${label}: ${alias} (${runRow.status}) ===`);
			for (const t of turns) {
				const turnEntries = entries.filter((e) => e.turn === t);
				console.log(`\n--- Turn ${t} (${turnEntries.length} entries) ---`);
				for (const e of turnEntries) {
					const meta = e.meta ? JSON.parse(e.meta) : null;
					const valPreview = (e.value || "").slice(0, 100).replace(/\n/g, "\\n");
					const metaPreview = meta ? ` meta:${JSON.stringify(meta).slice(0, 60)}` : "";
					console.log(`  [${e.domain}:${e.state}] ${e.key}${metaPreview}`);
					if (valPreview) console.log(`    → ${valPreview}`);
				}
			}
			console.log(`=== END ${alias} ===\n`);
		}
	}

	/**
	 * Assert a run result and dump audit on failure.
	 */
	async assertRun(result, validStatuses, message) {
		const statuses = Array.isArray(validStatuses) ? validStatuses : [validStatuses];
		if (!statuses.includes(result.status)) {
			await this.dumpAudit("FAILURE");
			throw new Error(
				`${message || "Unexpected status"}: expected ${statuses.join("|")}, got ${result.status} (run: ${result.run})`,
			);
		}
	}
}
