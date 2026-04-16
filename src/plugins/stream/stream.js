/**
 * Stream plugin — generic streaming entry infrastructure.
 *
 * Receives chunks from the client (or any producer) and appends them to
 * existing data entries. Producers (sh/env handlers) create the data
 * entries at status=102 on proposal acceptance; this plugin handles the
 * subsequent append + terminal-status transition via two RPC methods.
 *
 * Not a model-facing tool. No scheme, no tooldoc, no dispatch handler.
 * Pure RPC plumbing that any streaming-producer plugin can leverage.
 */
export default class Stream {
	#core;

	constructor(core) {
		this.#core = core;
		const hooks = core.hooks;
		const r = hooks.rpc.registry;

		// stream: append a chunk to a streaming entry.
		// Entry path is constructed as `${path}_${channel}` per the Unix FD
		// convention (1=stdout, 2=stderr, higher=other producer channels).
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

				const entryPath = `${params.path}_${params.channel}`;
				await ctx.projectAgent.entries.appendBody(
					runRow.id,
					entryPath,
					params.chunk,
				);
				return { status: "ok" };
			},
			description:
				"Append a chunk to a streaming entry channel. Used by clients and producers to grow a 102 entry's body.",
			params: {
				run: "string — run alias",
				path: "string — base path of the streaming producer (channel is appended)",
				channel: "number — channel index (Unix FD: 1=stdout, 2=stderr)",
				chunk: "string — content to append to the entry body",
			},
			requiresInit: true,
		});

		// stream/completed: transition all data channels for this producer
		// to their terminal status and finalize the log entry body.
		r.register("stream/completed", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");
				if (!params.path) throw new Error("path is required");

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`run not found: ${params.run}`);
				const runId = runRow.id;

				const exitCode = params.exit_code ?? 0;
				const duration = params.duration ?? null;
				const terminalStatus = exitCode === 0 ? 200 : 500;

				// Find all `{path}_*` data entries (channels 1, 2, ...).
				const channels = await ctx.projectAgent.entries.getEntriesByPattern(
					runId,
					`${params.path}_*`,
					null,
				);
				for (const ch of channels) {
					await ctx.db.resolve_known_entry.run({
						run_id: runId,
						path: ch.path,
						body: ch.body,
						status: terminalStatus,
					});
				}

				// Update the log entry body with final stats. Keep it terse —
				// one line summarizing exit code, duration, and channel sizes.
				const logEntry = await ctx.projectAgent.entries.getAttributes(
					runId,
					params.path,
				);
				const command = logEntry?.command || logEntry?.summary || "";
				const channelSummary = channels
					.map((c) => {
						const size = c.body ? `${c.tokens} tokens` : "empty";
						return `${c.path} (${size})`;
					})
					.join(", ");
				const dur = duration ? ` (${duration})` : "";
				const outcome = exitCode === 0 ? "exit=0" : `exit=${exitCode}`;
				const body = `ran '${command}', ${outcome}${dur}. Output: ${channelSummary}`;
				await ctx.db.resolve_known_entry.run({
					run_id: runId,
					path: params.path,
					body,
					status: 200,
				});

				return { status: "ok", channels: channels.length };
			},
			description:
				"Finalize a streaming producer. Transitions all `{path}_*` data channels to terminal status (200 on exit_code=0, 500 otherwise) and rewrites the log entry body with exit code, duration, and channel sizes.",
			params: {
				run: "string — run alias",
				path: "string — base path of the streaming producer",
				exit_code:
					"number? — exit code (0=success→200, non-zero=failure→500). Defaults to 0 for non-process producers.",
				duration: "string? — human-readable duration for the log entry",
			},
			requiresInit: true,
		});

		// stream/aborted: client-initiated cancellation. Transitions all data
		// channels to status 499 (Client Closed Request — the de-facto HTTP
		// status for client-terminated requests) and rewrites the log entry
		// body to note the abort. Shape mirrors stream/completed for client
		// symmetry: same run/path addressing, same channel sweep.
		r.register("stream/aborted", {
			handler: async (params, ctx) => {
				if (!params.run) throw new Error("run is required");
				if (!params.path) throw new Error("path is required");

				const runRow = await ctx.db.get_run_by_alias.get({
					alias: params.run,
				});
				if (!runRow) throw new Error(`run not found: ${params.run}`);
				const runId = runRow.id;

				const duration = params.duration ?? null;
				const reason = params.reason ?? null;

				const channels = await ctx.projectAgent.entries.getEntriesByPattern(
					runId,
					`${params.path}_*`,
					null,
				);
				for (const ch of channels) {
					await ctx.db.resolve_known_entry.run({
						run_id: runId,
						path: ch.path,
						body: ch.body,
						status: 499,
					});
				}

				const logEntry = await ctx.projectAgent.entries.getAttributes(
					runId,
					params.path,
				);
				const command = logEntry?.command || logEntry?.summary || "";
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
				await ctx.db.resolve_known_entry.run({
					run_id: runId,
					path: params.path,
					body,
					status: 200,
				});

				return { status: "ok", channels: channels.length };
			},
			description:
				"Abort a streaming producer. Transitions all `{path}_*` data channels to status 499 (Client Closed Request) and rewrites the log entry body to note the abort.",
			params: {
				run: "string — run alias",
				path: "string — base path of the streaming producer",
				reason:
					"string? — human-readable abort reason (e.g. 'user cancelled', 'timeout')",
				duration: "string? — human-readable duration at abort time",
			},
			requiresInit: true,
		});
	}
}
