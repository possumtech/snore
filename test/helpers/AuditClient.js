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
					await super.call("set", {
						run,
						path: p.path,
						state: "resolved",
						body: p.path?.startsWith("ask_user://") ? "N/A" : "",
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
		return super.call(method, params);
	}

	// Start a run and wait for terminal status. Returns { run, status, state }
	// where status === state (numeric HTTP-style). Covers what the legacy
	// `ask`/`act` RPC methods used to do: one call = one completed run.
	async #runUntilTerminal(mode, params = {}) {
		const {
			model,
			prompt,
			run,
			persona,
			fork,
			contextLimit,
			temperature,
			noRepo,
			noWeb,
			noProposals,
			noInteraction,
			timeoutMs = 300_000,
		} = params;
		const attributes = { model, mode };
		if (persona !== undefined) attributes.persona = persona;
		if (fork !== undefined) attributes.fork = fork;
		if (contextLimit !== undefined) attributes.contextLimit = contextLimit;
		if (temperature !== undefined) attributes.temperature = temperature;
		if (noRepo !== undefined) attributes.noRepo = noRepo;
		if (noWeb !== undefined) attributes.noWeb = noWeb;
		if (noProposals !== undefined) attributes.noProposals = noProposals;
		if (noInteraction !== undefined) attributes.noInteraction = noInteraction;
		const path = `run://${run ? run : ""}`;
		const startRes = await super.call("set", { path, body: prompt, attributes });
		const alias = startRes.alias;
		this.#currentRun = alias;
		const TERMINAL = [200, 204, 413, 422, 499, 500];
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const row = await this.#db.get_run_by_alias.get({ alias });
			if (row && TERMINAL.includes(row.status)) {
				return { run: alias, status: row.status, state: row.status };
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`run ${alias} did not reach terminal status in ${timeoutMs}ms`);
	}

	async ask(params) {
		return this.#runUntilTerminal("ask", params);
	}

	async act(params) {
		return this.#runUntilTerminal("act", params);
	}

	// Starts a run and returns immediately with { run, alias } — for tests
	// that want to observe the in-flight flow rather than wait for terminal.
	async startRun(params = {}) {
		const { model, mode = "ask", prompt = "", ...rest } = params;
		const attributes = { model, mode, ...rest };
		const res = await super.call("set", {
			path: "run://",
			body: prompt,
			attributes,
		});
		this.#currentRun = res.alias;
		return { run: res.alias, alias: res.alias };
	}

	// Resolve a proposal. resolution = { path, action: accept|reject|error, output? }
	async resolveProposal(run, resolution) {
		const stateMap = {
			accept: "resolved",
			reject: "cancelled",
			error: "failed",
		};
		const state = stateMap[resolution.action];
		if (!state)
			throw new Error(`resolveProposal: unknown action ${resolution.action}`);
		return super.call("set", {
			run,
			path: resolution.path,
			state,
			body: resolution.output,
		});
	}

	async abortRun(run) {
		return super.call("set", { path: `run://${run}`, state: "cancelled" });
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
