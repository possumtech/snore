/**
 * TelemetryPlugin: Console logging for RPC and turn events.
 * DB audit logging lives in ClientConnection (has db access).
 */
export default class TelemetryPlugin {
	static #starts = new Map();

	static register(hooks) {
		hooks.rpc.started.on(async ({ method, id, params }) => {
			TelemetryPlugin.#starts.set(id, Date.now());
			const summary =
				method === "ask" || method === "act"
					? `prompt="${(params?.prompt || "").slice(0, 60)}"`
					: method === "run/abort"
						? `run=${params?.run}`
						: method === "run/resolve"
							? `run=${params?.run} action=${params?.resolution?.action}`
							: "";
			console.log(`[RPC] → ${method}(${id})${summary ? ` ${summary}` : ""}`);
		});

		hooks.rpc.completed.on(async ({ method, id, result }) => {
			const elapsed = TelemetryPlugin.#starts.has(id)
				? `${((Date.now() - TelemetryPlugin.#starts.get(id)) / 1000).toFixed(1)}s`
				: "";
			TelemetryPlugin.#starts.delete(id);
			const summary = result?.run
				? `run=${result.run} status=${result.status || "ok"}`
				: result?.status
					? `status=${result.status}`
					: "";
			console.log(
				`[RPC] ← ${method}(${id}) ${elapsed}${summary ? ` ${summary}` : ""}`,
			);
		});

		hooks.rpc.error.on(async ({ id, error }) => {
			const elapsed = TelemetryPlugin.#starts.has(id)
				? `${((Date.now() - TelemetryPlugin.#starts.get(id)) / 1000).toFixed(1)}s`
				: "";
			TelemetryPlugin.#starts.delete(id);
			console.error(`[RPC] ✗ (${id}) ${elapsed} ${error?.message || error}`);
		});

		hooks.run.step.completed.on(async (payload) => {
			if (process.env.RUMMY_DEBUG !== "true") return;
			console.log(
				`[DEBUG] Turn ${payload.turn} completed for run ${payload.run}`,
			);
		});
	}
}
