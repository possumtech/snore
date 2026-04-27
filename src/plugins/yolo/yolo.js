import { spawn } from "node:child_process";
import { logPathToDataBase } from "../helpers.js";

const SH_PATH_RE = /^log:\/\/turn_\d+\/(sh|env)\//;

/**
 * YOLO plugin — for runs started with `yolo: true`, auto-resolves every
 * proposal server-side and spawns sh/env commands locally, streaming
 * output to the same data-channel entries the existing `stream`/
 * `stream/completed` RPC contract uses.
 *
 * Pattern parallel to `noRepo`/`noWeb`/`noInteraction`/`noProposals`:
 * `yolo` is a run attribute plumbed via rpc.js → AgentLoop loop config →
 * RummyContext.yolo. This plugin reads `rummy.yolo` off the proposal
 * payload and engages only when set; non-yolo runs are unaffected.
 *
 * The plugin replicates AgentLoop.resolve()'s accept path inline rather
 * than calling an exposed projectAgent — keeps yolo logic contained in
 * the yolo plugin and out of backbone files.
 */
export default class Yolo {
	constructor(core) {
		this.core = core;
		core.hooks.proposal.pending.on(this.#onPending.bind(this));
	}

	async #onPending({ run, proposed, rummy }) {
		if (!rummy?.yolo) return;
		for (const p of proposed) {
			// Resolve first — that fires proposal.accepted, which lets the
			// sh/env plugin seed the streaming channel entries. Then spawn
			// into those existing channels. If we spawned first, sh.js's
			// post-accept channel creation would clobber the body we just
			// streamed (sets state=streaming, body="").
			await this.#serverResolve(rummy, p.path);
			if (SH_PATH_RE.test(p.path)) {
				await this.#executeShellProposal(rummy, p.path);
			}
		}
	}

	/**
	 * Replicate AgentLoop.resolve()'s accept path: accepting filter
	 * (veto check), content filter (resolved body), set state="resolved",
	 * emit proposal.accepted for plugin side effects.
	 */
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

		const resolvedBody = await this.core.hooks.proposal.content.filter(
			"",
			ctx,
		);
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

	/**
	 * Spawn the sh/env command locally and stream stdout/stderr into
	 * `{dataBase}_1` and `{dataBase}_2` data entries. Mirrors the
	 * stream/stream-completed RPC contract — same channel layout, same
	 * terminal-state transitions on exit. Done inline (no RPC roundtrip)
	 * so the run is fully autonomous.
	 */
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
		const child = spawn("bash", ["-lc", command], {
			cwd: projectRoot,
			env: process.env,
		});
		// Buffer chunks synchronously and write once after exit. Avoids
		// the race where multiple async appends interleave with the
		// terminal-state transition fired on 'close'.
		const stdoutChunks = [];
		const stderrChunks = [];
		child.stdout.on("data", (data) => stdoutChunks.push(data.toString()));
		child.stderr.on("data", (data) => stderrChunks.push(data.toString()));

		await new Promise((resolve) => {
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
				// Transition state without touching body — getState doesn't
				// return body, and entries.set with body=undefined preserves
				// the streamed content already in place. (`body: ""` would
				// wipe everything we just streamed.)
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
						.map((c) => `${c.path} (${c.tokens || 0} tokens)`)
						.join(", ");
					const exitLabel =
						exitCode === 0 ? "exit=0" : `exit=${exitCode}`;
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
