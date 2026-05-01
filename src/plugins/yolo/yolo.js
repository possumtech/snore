import { spawn } from "node:child_process";
import { logPathToDataBase } from "../helpers.js";

const SH_PATH_RE = /^log:\/\/turn_\d+\/(sh|env)\//;

// Auto-resolves proposals + spawns sh/env locally for runs started with yolo:true. SPEC #yolo_mode.
export default class Yolo {
	constructor(core) {
		this.core = core;
		core.hooks.proposal.pending.on(this.#onPending.bind(this));
	}

	async #onPending({ proposed, rummy }) {
		if (!rummy?.yolo) return;
		for (const p of proposed) {
			// Resolve first so sh/env's post-accept seeds channels before we stream into them.
			await this.#serverResolve(rummy, p.path);
			if (SH_PATH_RE.test(p.path)) {
				await this.#executeShellProposal(rummy, p.path);
			}
		}
	}

	// Inline mirror of AgentLoop.resolve()'s accept path.
	async #serverResolve(rummy, path) {
		const runId = rummy.runId;
		const entries = rummy.entries;
		const db = rummy.db;
		const runRow = await db.get_run_by_id.get({ id: runId });
		const project = await db.get_project_by_id.get({ id: runRow.project_id });
		const attrs = await entries.getAttributes(runId, path);
		const ctx = {
			runId,
			runRow,
			projectId: runRow.project_id,
			projectRoot: project?.project_root,
			path,
			attrs,
			output: "",
			db,
			entries,
		};

		const veto = await this.core.hooks.proposal.accepting.filter(null, ctx);
		if (veto?.allow === false) {
			await entries.set({
				runId,
				path,
				state: "failed",
				outcome: veto.outcome,
				body: veto.body,
			});
			return;
		}

		const resolvedBody = await this.core.hooks.proposal.content.filter("", ctx);
		const existing = await entries.getState(runId, path);
		const existingTurn = existing?.turn === undefined ? 0 : existing.turn;
		await entries.set({
			runId,
			turn: existingTurn,
			path,
			state: "resolved",
			body: resolvedBody,
		});
		await this.core.hooks.proposal.accepted.emit({ ...ctx, resolvedBody });
	}

	// Spawn locally and stream into {dataBase}_{1,2}; mirrors stream/stream-completed RPC.
	async #executeShellProposal(rummy, logPath) {
		const runId = rummy.runId;
		const entries = rummy.entries;
		const db = rummy.db;
		const runRow = await db.get_run_by_id.get({ id: runId });
		const project = await db.get_project_by_id.get({ id: runRow.project_id });
		const projectRoot = project?.project_root;
		if (!projectRoot) return;

		const attrs = await entries.getAttributes(runId, logPath);
		const command = attrs?.command || attrs?.summary;
		if (!command) return;

		const dataBase = logPathToDataBase(logPath);
		if (!dataBase) return;
		const stdoutPath = `${dataBase}_1`;
		const stderrPath = `${dataBase}_2`;

		const start = Date.now();
		// signal: tied to AgentLoop's per-run AbortController. When drain
		// fires (cli.js watchdog or external abort), Node's spawn auto-
		// kills the child via SIGTERM, which unblocks the close-promise
		// below. Without this, a long-running <sh> (e.g. pip install,
		// server startup, vim) holds the run promise pending past
		// harbor's outer SIGKILL deadline and the post-mortem packet
		// (rummy.db, turns/, last_run.txt) never exfils. Verified
		// pathology in the 2026-05-01 pypi-server tbench trial.
		const child = spawn("bash", ["-lc", command], {
			cwd: projectRoot,
			env: process.env,
			signal: rummy.signal ?? undefined,
		});
		// Buffer + write-once-on-exit; async appends would race the terminal-state transition.
		const stdoutChunks = [];
		const stderrChunks = [];
		child.stdout.on("data", (data) => stdoutChunks.push(data.toString()));
		child.stderr.on("data", (data) => stderrChunks.push(data.toString()));

		await new Promise((resolve) => {
			let launched = false;
			child.on("spawn", () => {
				launched = true;
			});
			// Once the process is launched, "close" will fire even on
			// SIGTERM-from-abort (after the process dies + stdio streams
			// close) — let the close handler below write the terminal
			// state. If "error" fires BEFORE "spawn", the launch itself
			// failed (binary missing, cwd invalid) and "close" will never
			// arrive, so we resolve here to keep drain from hanging past
			// the harbor SIGKILL deadline. Verified pypi-server pathology
			// 2026-05-01.
			child.on("error", () => {
				if (!launched) resolve();
			});
			child.on("close", async (code) => {
				const stdoutBody = stdoutChunks.join("");
				const stderrBody = stderrChunks.join("");
				if (stdoutBody) {
					try {
						await entries.set({
							runId,
							path: stdoutPath,
							body: stdoutBody,
							append: true,
						});
					} catch {}
				}
				if (stderrBody) {
					try {
						await entries.set({
							runId,
							path: stderrPath,
							body: stderrBody,
							append: true,
						});
					} catch {}
				}
				const exitCode = code === null ? 130 : code;
				const duration = `${Math.round((Date.now() - start) / 1000)}s`;
				const terminalState = exitCode === 0 ? "resolved" : "failed";
				const outcome = exitCode === 0 ? null : `exit:${exitCode}`;
				// body=undefined preserves streamed content; body="" would wipe it.
				for (const path of [stdoutPath, stderrPath]) {
					try {
						await entries.set({
							runId,
							path,
							state: terminalState,
							outcome,
						});
					} catch {}
				}
				try {
					const channels = await entries.getEntriesByPattern(
						runId,
						`${dataBase}_*`,
						null,
					);
					const summary = channels
						.map((c) => `${c.path} (${c.tokens} tokens)`)
						.join(", ");
					const exitLabel = exitCode === 0 ? "exit=0" : `exit=${exitCode}`;
					await entries.set({
						runId,
						path: logPath,
						state: "resolved",
						body: `ran '${command}', ${exitLabel} (${duration}). Output: ${summary}`,
					});
				} catch {}
				resolve();
			});
		});
	}
}
