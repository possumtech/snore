import { spawn } from "node:child_process";
import { logPathToDataBase } from "../helpers.js";
import finalizeStream from "../stream/finalize.js";

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
				// Fire-and-forget: spawn returns and yolo never blocks. If
				// the child outlives the loop, finalizeStream wakes the run
				// with a fresh prompt so the agent gets a turn to react.
				// SPEC #streaming_entries.
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

	// Spawn locally and stream into {dataBase}_{1,2}; finalization (channel
	// terminal states, log-body rewrite, dormant-run wake) is delegated to
	// stream/finalize so yolo and external producers share one termination
	// site. Fire-and-forget: spawn returns synchronously; the close handler
	// runs whenever the child exits, regardless of whether the loop that
	// proposed the <sh> is still alive.
	#executeShellProposal(rummy, logPath) {
		const runId = rummy.runId;
		const entries = rummy.entries;
		const db = rummy.db;
		const hooks = this.core.hooks;

		(async () => {
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
			// Shell argv defaults to ["bash", "-lc"] — a host-shell exec.
			// `RUMMY_SHELL_ARGV` (JSON array) routes commands elsewhere:
			// benchmark integrations set it to docker-exec into a per-task
			// isolated container so the agent's `<sh>` runs without host
			// filesystem access or network reach. Example:
			//   ["docker","exec","--workdir","/workspace","<cid>","bash","-lc"]
			const argvJson = process.env.RUMMY_SHELL_ARGV;
			const shellArgv = argvJson ? JSON.parse(argvJson) : ["bash", "-lc"];
			// signal: AbortController kills the child if the user aborts
			// the run. Children that simply outlive their loop are not
			// killed — finalizeStream wakes the run when they close.
			const child = spawn(shellArgv[0], [...shellArgv.slice(1), command], {
				cwd: projectRoot,
				env: process.env,
				signal: rummy.signal ?? undefined,
			});

			// Append chunks via per-channel promise chains so concurrent
			// appends don't race for body order in SQLite.
			const stdoutRef = { value: Promise.resolve() };
			const stderrRef = { value: Promise.resolve() };
			const appendChunk = (path, body, queueRef) => {
				queueRef.value = queueRef.value
					.then(() => entries.set({ runId, path, body, append: true }))
					.catch((err) => {
						console.error(`[yolo] append to ${path} failed: ${err.message}`);
					});
			};
			child.stdout.on("data", (data) => {
				appendChunk(stdoutPath, data.toString(), stdoutRef);
			});
			child.stderr.on("data", (data) => {
				appendChunk(stderrPath, data.toString(), stderrRef);
			});

			let launched = false;
			child.on("spawn", () => {
				launched = true;
			});
			// Launch failure (binary missing, cwd invalid): no "close"
			// arrives, so finalize directly with a non-zero exit.
			child.on("error", async (err) => {
				if (launched) return;
				try {
					await finalizeStream({
						db,
						entries,
						hooks,
						runRow,
						path: logPath,
						exitCode: 127,
						duration: `${Math.round((Date.now() - start) / 1000)}s`,
					});
				} catch (e) {
					console.error(`[yolo] finalize on launch error failed: ${e.message}`);
				}
				console.error(`[yolo] spawn failed: ${err.message}`);
			});
			child.on("close", async (code) => {
				// Drain per-channel append queues before finalizing so the
				// terminal-state write can't land before the last chunk.
				await Promise.allSettled([stdoutRef.value, stderrRef.value]);
				const exitCode = code === null ? 130 : code;
				const duration = `${Math.round((Date.now() - start) / 1000)}s`;
				try {
					await finalizeStream({
						db,
						entries,
						hooks,
						runRow,
						path: logPath,
						exitCode,
						duration,
					});
				} catch (err) {
					console.error(`[yolo] finalize failed: ${err.message}`);
				}
			});
		})().catch((err) => {
			console.error(`[yolo] child lifecycle errored: ${err.message}`);
		});
	}
}
