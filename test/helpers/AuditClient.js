import fs from "node:fs/promises";
import { join } from "node:path";
import RpcClient from "./RpcClient.js";

/**
 * AuditClient wraps RpcClient with per-run audit tracking.
 * Dumps the SPECIFIC failing run's K/V state on assertion failure.
 * Auto-resolves proposals via run/proposal notifications.
 */
export default class AuditClient extends RpcClient {
	#db;
	#currentRun = null;
	#projectRoot = null;
	#resolveHandler = null;

	constructor(url, db, { projectRoot } = {}) {
		super(url);
		this.#db = db;
		this.#projectRoot = projectRoot;
		this.#setupAutoResolve();
	}

	set projectRoot(path) {
		this.#projectRoot = path;
	}

	set resolveHandler(fn) {
		this.#resolveHandler = fn;
	}

	#setupAutoResolve() {
		this.on("run/proposal", async ({ run, proposed }) => {
			for (const p of proposed || []) {
				try {
					// Custom handler overrides auto-accept
					if (this.#resolveHandler) {
						await this.#resolveHandler(this, run, p);
						continue;
					}
					// Apply file edits to disk before accepting
					if (p.path?.startsWith("set://") && this.#projectRoot) {
						await this.#applySetToDisk(run, p.path);
					}
					if (p.path?.startsWith("rm://") && this.#projectRoot) {
						await this.#applyRmToDisk(run, p.path);
					}
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

	async #applySetToDisk(run, path) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: run });
		if (!runRow) return;
		const entries = await this.#db.get_known_entries.all({
			run_id: runRow.id,
		});
		const setEntry = entries.find((e) => e.path === path);
		if (!setEntry) return;
		const attrs =
			typeof setEntry.attributes === "string"
				? JSON.parse(setEntry.attributes)
				: setEntry.attributes;
		if (!attrs?.path || !attrs?.merge) return;
		const filePath = join(this.#projectRoot, attrs.path);
		const content = await fs.readFile(filePath, "utf8").catch(() => "");
		const blocks = attrs.merge.split(/(?=<<<<<<< SEARCH)/);
		let patched = content;
		for (const block of blocks) {
			const match = block.match(
				/<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n?([\s\S]*?)\n?>>>>>>> REPLACE/,
			);
			if (!match) continue;
			if (match[1] === "") {
				patched = match[2];
			} else {
				patched = patched.replace(match[1], match[2]);
			}
		}
		if (patched !== content) await fs.writeFile(filePath, patched);
	}

	async #applyRmToDisk(run, path) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: run });
		if (!runRow) return;
		const entries = await this.#db.get_known_entries.all({
			run_id: runRow.id,
		});
		const rmEntry = entries.find((e) => e.path === path);
		if (!rmEntry) return;
		const attrs =
			typeof rmEntry.attributes === "string"
				? JSON.parse(rmEntry.attributes)
				: rmEntry.attributes;
		if (attrs?.path) {
			await fs.unlink(join(this.#projectRoot, attrs.path)).catch(() => {});
		}
	}

	async call(method, params = {}) {
		const result = await super.call(method, params);

		if ((method === "ask" || method === "act") && result?.run) {
			this.#currentRun = result.run;
		}

		return result;
	}

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
			`\n=== AUDIT: ${alias} (${runRow.state}, ${entries.length} entries) ===`,
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

	async assertRun(result, validStatuses, label) {
		const statuses = Array.isArray(validStatuses)
			? validStatuses
			: [validStatuses];
		if (!statuses.includes(result.state)) {
			await this.dumpRun(result.run);
			throw new Error(
				`${label}: expected ${statuses.join("|")}, got ${result.state} (run: ${result.run})`,
			);
		}
	}
}
