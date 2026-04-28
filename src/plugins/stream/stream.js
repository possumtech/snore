import { logPathToDataBase } from "../helpers.js";

// RPC plumbing that appends/terminates streaming data entries; see plugin README.
export default class Stream {
	#core;

	constructor(core) {
		this.#core = core;
		const hooks = core.hooks;
		const r = hooks.rpc.registry;

		// stream: append chunk; channel = Unix FD (1=stdout, 2=stderr).
		r.register("stream", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");
				if (!params.path) throw new Error("path is required");
				if (params.channel == null)
					throw new Error("channel is required (numeric)");
				if (params.chunk == null) throw new Error("chunk is required");

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`run not found: ${params.run}`);

				const dataBase = logPathToDataBase(params.path);
				if (!dataBase) {
					throw new Error(
						`path must be a log entry (log://turn_N/...); got: ${params.path}`,
					);
				}
				const entryPath = `${dataBase}_${params.channel}`;
				await ctx.projectAgent.entries.set({
					runId: runRow.id,
					path: entryPath,
					body: params.chunk,
					append: true,
				});
				return { status: "ok" };
			},
			description:
				"Append a chunk to a streaming entry channel. Used by clients and producers to grow a 102 entry's body.",
			params: {
				run: "string — run alias",
				path: "string — log-entry path (log://turn_N/{action}/{slug}); server derives the data channel path",
				channel: "number — channel index (Unix FD: 1=stdout, 2=stderr)",
				chunk: "string — content to append to the entry body",
			},
			requiresInit: true,
		});

		// stream/completed: terminal status on all channels + finalize log body.
		r.register("stream/completed", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");
				if (!params.path) throw new Error("path is required");

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`run not found: ${params.run}`);
				const runId = runRow.id;

				const { exit_code: exitCode = 0, duration = null } = params;
				const terminalState = exitCode === 0 ? "resolved" : "failed";
				const terminalOutcome = exitCode === 0 ? null : `exit:${exitCode}`;

				const dataBase = logPathToDataBase(params.path);
				if (!dataBase) {
					throw new Error(
						`path must be a log entry (log://turn_N/...); got: ${params.path}`,
					);
				}
				// Find all `{dataBase}_*` data entries (channels 1, 2, ...).
				const store = ctx.projectAgent.entries;
				const channels = await store.getEntriesByPattern(
					runId,
					`${dataBase}_*`,
					null,
				);
				for (const ch of channels) {
					await store.set({
						runId,
						path: ch.path,
						state: terminalState,
						body: ch.body,
						outcome: terminalOutcome,
					});
				}

				// One-line final stats for the log entry body.
				const logEntry = await store.getAttributes(runId, params.path);
				let command = "";
				if (logEntry?.command) command = logEntry.command;
				else if (logEntry?.summary) command = logEntry.summary;
				const channelSummary = channels
					.map((c) => {
						const size = c.body ? `${c.tokens} tokens` : "empty";
						return `${c.path} (${size})`;
					})
					.join(", ");
				const dur = duration ? ` (${duration})` : "";
				const exitLabel = exitCode === 0 ? "exit=0" : `exit=${exitCode}`;
				const body = `ran '${command}', ${exitLabel}${dur}. Output: ${channelSummary}`;
				await store.set({ runId, path: params.path, state: "resolved", body });

				return { ok: true, channels: channels.length };
			},
			description:
				"Finalize a streaming producer. Transitions all `{path}_*` data channels to terminal status (200 on exit_code=0, 500 otherwise) and rewrites the log entry body with exit code, duration, and channel sizes.",
			params: {
				run: "string — run alias",
				path: "string — log-entry path (log://turn_N/{action}/{slug}); server derives the data channel path",
				exit_code:
					"number? — exit code (0=success→200, non-zero=failure→500). Defaults to 0 for non-process producers.",
				duration: "string? — human-readable duration for the log entry",
			},
			requiresInit: true,
		});

		// stream/aborted: client cancellation; channels → 499; mirrors stream/completed.
		r.register("stream/aborted", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");
				if (!params.path) throw new Error("path is required");

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`run not found: ${params.run}`);
				const runId = runRow.id;

				const { duration = null, reason = null } = params;

				const dataBase = logPathToDataBase(params.path);
				if (!dataBase) {
					throw new Error(
						`path must be a log entry (log://turn_N/...); got: ${params.path}`,
					);
				}
				const store = ctx.projectAgent.entries;
				const channels = await store.getEntriesByPattern(
					runId,
					`${dataBase}_*`,
					null,
				);
				for (const ch of channels) {
					await store.set({
						runId,
						path: ch.path,
						state: "cancelled",
						body: ch.body,
						outcome: reason ? reason : "aborted",
					});
				}

				const logEntry = await store.getAttributes(runId, params.path);
				let command = "";
				if (logEntry?.command) command = logEntry.command;
				else if (logEntry?.summary) command = logEntry.summary;
				const channelSummary = channels
					.map((c) => {
						const size = c.body ? `${c.tokens} tokens` : "empty";
						return `${c.path} (${size})`;
					})
					.join(", ");
				const qualifiers = [];
				if (reason) qualifiers.push(reason);
				if (duration) qualifiers.push(duration);
				const qualifier = qualifiers.length
					? ` (${qualifiers.join(", ")})`
					: "";
				const body = `aborted '${command}'${qualifier}. Output: ${channelSummary}`;
				await store.set({ runId, path: params.path, state: "resolved", body });

				return { status: "ok", channels: channels.length };
			},
			description:
				"Abort a streaming producer. Transitions all `{path}_*` data channels to status 499 (Client Closed Request) and rewrites the log entry body to note the abort.",
			params: {
				run: "string — run alias",
				path: "string — log-entry path (log://turn_N/{action}/{slug}); server derives the data channel path",
				reason:
					"string? — human-readable abort reason (e.g. 'user cancelled', 'timeout')",
				duration: "string? — human-readable duration at abort time",
			},
			requiresInit: true,
		});

		// stream/cancel: server-initiated; pushes stream/cancelled notification; cleans stale 102s.
		r.register("stream/cancel", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");
				if (!params.path) throw new Error("path is required");

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`run not found: ${params.run}`);
				const runId = runRow.id;

				const { reason = null } = params;

				const dataBase = logPathToDataBase(params.path);
				if (!dataBase) {
					throw new Error(
						`path must be a log entry (log://turn_N/...); got: ${params.path}`,
					);
				}
				const store = ctx.projectAgent.entries;
				const channels = await store.getEntriesByPattern(
					runId,
					`${dataBase}_*`,
					null,
				);
				for (const ch of channels) {
					await store.set({
						runId,
						path: ch.path,
						state: "cancelled",
						body: ch.body,
						outcome: reason ? reason : "cancelled",
					});
				}

				const logEntry = await store.getAttributes(runId, params.path);
				let command = "";
				if (logEntry?.command) command = logEntry.command;
				else if (logEntry?.summary) command = logEntry.summary;
				const channelSummary = channels
					.map((c) => {
						const size = c.body ? `${c.tokens} tokens` : "empty";
						return `${c.path} (${size})`;
					})
					.join(", ");
				const qualifier = reason ? ` (${reason})` : "";
				const body = `cancelled '${command}'${qualifier}. Output: ${channelSummary}`;
				await store.set({ runId, path: params.path, state: "resolved", body });

				// Notify connected clients so they can kill local processes.
				hooks.stream.cancelled.emit({
					projectId: ctx.projectId,
					run: params.run,
					path: params.path,
					reason,
				});

				return { ok: true, channels: channels.length };
			},
			description:
				"Server-initiated cancellation. Transitions all `{path}_*` data channels to status 499 and pushes a stream/cancelled notification to connected clients. Also used for stale 102 cleanup when the originating client is gone.",
			params: {
				run: "string — run alias",
				path: "string — log-entry path (log://turn_N/{action}/{slug}); server derives the data channel path",
				reason:
					"string? — cancellation reason (e.g. 'budget exceeded', 'stale cleanup', 'user cancelled from another client')",
			},
			requiresInit: true,
		});
	}
}
