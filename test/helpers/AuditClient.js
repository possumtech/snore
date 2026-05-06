import fs from "node:fs/promises";
import { join } from "node:path";
import RpcClient from "./RpcClient.js";

/**
 * AuditClient wraps RpcClient with per-run audit tracking.
 * Dumps the SPECIFIC failing run's K/V state on assertion failure.
 * Auto-resolves proposals: subscribes to run/changed pulses, queries
 * getEntries(run, { since }) to find new proposed entries, resolves them.
 */
export default class AuditClient extends RpcClient {
	#db;
	#currentRun = null;
	#projectRoot = null;
	#resolveHandler = null;
	#resolvedPaths = new Set();

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

	// Subscribe to run/changed, scan for proposed entries, auto-resolve.
	// We full-scan every pulse rather than filter by `since: lastSeen`
	// because state transitions (resolved→proposed when a plugin hook
	// materializes a proposal) don't allocate new entry ids — the run_view
	// row is rewritten in place. A since-based filter would advance past
	// the entry on its first-write snapshot and miss the second write's
	// state transition. Idempotent via #resolvedPaths.
	#setupAutoResolve() {
		this.on("run/changed", async ({ run }) => {
			let entries;
			try {
				entries = await super.call("getEntries", {
					run,
					pattern: "**",
				});
			} catch {
				return;
			}
			for (const e of entries) {
				if (e.state !== "proposed") continue;
				const key = `${run}:${e.path}`;
				if (this.#resolvedPaths.has(key)) continue;
				this.#resolvedPaths.add(key);
				try {
					if (this.#resolveHandler) {
						await this.#resolveHandler(this, run, e);
						continue;
					}
					if (e.path?.startsWith("set://") && this.#projectRoot) {
						await this.#applySetToDisk(run, e.path);
					}
					if (e.path?.startsWith("rm://") && this.#projectRoot) {
						await this.#applyRmToDisk(run, e.path);
					}
					await super.call("set", {
						run,
						path: e.path,
						state: "resolved",
						body: e.path?.startsWith("ask_user://") ? "N/A" : "",
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
			yolo,
			timeoutMs = Number.parseInt(process.env.RUMMY_TEST_RUN_TIMEOUT, 10),
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
		if (yolo !== undefined) attributes.yolo = yolo;
		const path = `run://${run ? run : ""}`;
		const startRes = await super.call("set", {
			path,
			body: prompt,
			attributes,
		});
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
		// Abort the run before throwing so it doesn't keep emitting turns
		// in the server with stale resolver state in the test session.
		// Without this, a timed-out act() leaves a zombie run that a
		// subsequent client.resolveHandler clear can render destructive
		// (default auto-resolver accepts proposals the test meant to reject).
		await this.abortRun(alias).catch(() => {});
		throw new Error(
			`run ${alias} did not reach terminal status in ${timeoutMs}ms`,
		);
	}

	async ask(params) {
		return this.#runUntilTerminal("ask", params);
	}

	async act(params) {
		return this.#runUntilTerminal("act", params);
	}

	// Starts a run and waits for the run row to exist in the DB.
	// Returns { run, alias } — for tests that want to observe the in-flight
	// flow (seed proposals, stream chunks) rather than wait for terminal.
	// The server kicks off the run async and returns the alias immediately;
	// we poll until the row is visible so tests can safely seed by alias.
	async startRun(params = {}) {
		const { model, mode = "ask", prompt = "", ...rest } = params;
		const attributes = { model, mode, ...rest };
		const res = await super.call("set", {
			path: "run://",
			body: prompt,
			attributes,
		});
		this.#currentRun = res.alias;
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const row = await this.#db.get_run_by_alias.get({ alias: res.alias });
			if (row) return { run: res.alias, alias: res.alias };
			await new Promise((r) => setTimeout(r, 25));
		}
		throw new Error(`startRun: run row not created for ${res.alias}`);
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
		const bodyLimit = Number(process.env.RUMMY_AUDIT_BODY_LIMIT || 120);
		for (const t of turns) {
			const turnEntries = entries.filter((e) => e.turn === t);
			console.log(`\n  Turn ${t}:`);
			for (const e of turnEntries) {
				const attrs = e.attributes ? JSON.parse(e.attributes) : null;
				const val = (e.body || "").slice(0, bodyLimit).replace(/\n/g, "\\n");
				const attrsStr = attrs ? ` ${JSON.stringify(attrs).slice(0, 200)}` : "";
				console.log(
					`    ${e.scheme}:${e.state}:${e.visibility} ${e.path}${attrsStr}`,
				);
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
