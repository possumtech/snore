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
				// Fire-and-forget: spawn returns immediately after wiring;
				// the close-promise is registered on rummy.pendingChildren
				// so the agent loop can drain before truly terminating.
				// Awaiting here would re-introduce the hang on long-running
				// children (screensavers, daemons, REPLs). SPEC #streaming_entries.
				this.#executeShellProposal(rummy, p.path);
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
	// Returns synchronously after wiring; the close-promise is registered
	// on rummy.pendingChildren so the agent loop can drain it before
	// terminating, but turn execution NEVER awaits the child.
	#executeShellProposal(rummy, logPath) {
		const runId = rummy.runId;
		const entries = rummy.entries;
		const db = rummy.db;

		const closePromise = (async () => {
			const runRow = await db.get_run_by_id.get({ id: runId });
			const project = await db.get_project_by_id.get({
				id: runRow.project_id,
			});
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
			// signal: tied to AgentLoop's per-run AbortController. When
			// drain fires (cli.js watchdog or external abort), Node's
			// spawn auto-kills the child via SIGTERM. Streamed entries
			// land via the data handlers below; the close handler does
			// terminal-state writes.
			const child = spawn("bash", ["-lc", command], {
				cwd: projectRoot,
				env: process.env,
				signal: rummy.signal ?? undefined,
			});

			// Append chunks to the streaming entries as they arrive.
			// Serialize via a per-channel promise chain so concurrent
			// appends don't race for body order in SQLite. Errors are
			// logged but don't break the chain.
			const stdoutQueue = Promise.resolve();
			const stderrQueue = Promise.resolve();
			const appendChunk = (path, body, queueRef) => {
				const q = queueRef.value
					.then(() => entries.set({ runId, path, body, append: true }))
					.catch((err) => {
						console.error(`[yolo] append to ${path} failed: ${err.message}`);
					});
				queueRef.value = q;
			};
			const stdoutRef = { value: stdoutQueue };
			const stderrRef = { value: stderrQueue };
			child.stdout.on("data", (data) => {
				appendChunk(stdoutPath, data.toString(), stdoutRef);
			});
			child.stderr.on("data", (data) => {
				appendChunk(stderrPath, data.toString(), stderrRef);
			});

			await new Promise((resolve) => {
				let launched = false;
				child.on("spawn", () => {
					launched = true;
				});
				// If "error" fires BEFORE "spawn", the launch itself failed
				// (binary missing, cwd invalid) and "close" will never
				// arrive — resolve here so drain doesn't hang. Verified
				// pypi-server pathology 2026-05-01.
				child.on("error", () => {
					if (!launched) resolve();
				});
				child.on("close", async (code) => {
					// Drain the per-channel append queues before writing
					// the terminal state, so the final state-transition
					// can't land before the last data chunk.
					await Promise.allSettled([stdoutRef.value, stderrRef.value]);

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
		})();

		// Register so the agent loop can drain pending children before
		// terminating. trackChild auto-deletes on settle. Failures inside
		// the IIFE shouldn't break the loop, so swallow them here.
		closePromise.catch((err) => {
			console.error(`[yolo] child lifecycle errored: ${err.message}`);
		});
		rummy.trackChild?.(closePromise);
	}
}
