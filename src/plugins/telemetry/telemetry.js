import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TelemetryPlugin: Console logging for RPC and turn events.
 * Dumps raw LLM messages/responses to last_run.txt in RUMMY_HOME.
 */
export default class TelemetryPlugin {
	static #starts = new Map();
	static #lastRunPath = null;
	static #turnLog = [];

	static register(hooks) {
		const home = process.env.RUMMY_HOME;
		if (home) TelemetryPlugin.#lastRunPath = join(home, "last_run.txt");

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

			if (method === "ask" || method === "act") {
				TelemetryPlugin.#turnLog = [];
			}
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

		hooks.llm.messages.addFilter(async (messages, context) => {
			TelemetryPlugin.#appendTurn(
				`\n${"=".repeat(60)}\nTURN — model=${context.model} run=${context.runId}\n${"=".repeat(60)}`,
			);
			for (const msg of messages) {
				const label = msg.role.toUpperCase();
				const body =
					typeof msg.content === "string"
						? msg.content
						: JSON.stringify(msg.content);
				TelemetryPlugin.#appendTurn(`\n--- ${label} ---\n${body}`);
			}
			return messages;
		}, 999);

		hooks.llm.response.addFilter(async (response, _context) => {
			const msg = response.choices?.[0]?.message;
			TelemetryPlugin.#appendTurn(
				`\n--- ASSISTANT ---\n${msg?.content || "(empty)"}`,
			);
			if (msg?.reasoning_content) {
				TelemetryPlugin.#appendTurn(
					`\n--- REASONING ---\n${msg.reasoning_content}`,
				);
			}
			const usage = response.usage || {};
			TelemetryPlugin.#appendTurn(`\n--- USAGE ---\n${JSON.stringify(usage)}`);
			TelemetryPlugin.#flush();
			return response;
		}, 999);
	}

	static #appendTurn(text) {
		TelemetryPlugin.#turnLog.push(text);
	}

	static #flush() {
		if (!TelemetryPlugin.#lastRunPath || TelemetryPlugin.#turnLog.length === 0)
			return;
		try {
			writeFileSync(
				TelemetryPlugin.#lastRunPath,
				`${TelemetryPlugin.#turnLog.join("\n")}\n`,
			);
		} catch {
			// RUMMY_HOME may not exist yet
		}
	}
}
