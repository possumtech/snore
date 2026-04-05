import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default class Telemetry {
	#core;
	#starts = new Map();
	#lastRunPath = null;
	#turnLog = [];

	constructor(core) {
		this.#core = core;

		const home = process.env.RUMMY_HOME;
		if (home) this.#lastRunPath = join(home, "last_run.txt");

		core.on("rpc.started", this.#onRpcStarted.bind(this));
		core.on("rpc.completed", this.#onRpcCompleted.bind(this));
		core.on("rpc.error", this.#onRpcError.bind(this));
		core.on("run.step.completed", this.#onStepCompleted.bind(this));
		core.filter("llm.messages", this.#logMessages.bind(this), 999);
		core.filter("llm.response", this.#logResponse.bind(this), 999);
	}

	async #onRpcStarted({ method, id, params }) {
		this.#starts.set(id, Date.now());
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
			this.#turnLog = [];
		}
	}

	async #onRpcCompleted({ method, id, result }) {
		const elapsed = this.#starts.has(id)
			? `${((Date.now() - this.#starts.get(id)) / 1000).toFixed(1)}s`
			: "";
		this.#starts.delete(id);
		const summary = result?.run
			? `run=${result.run} status=${result.status || "ok"}`
			: result?.status
				? `status=${result.status}`
				: "";
		console.log(
			`[RPC] ← ${method}(${id}) ${elapsed}${summary ? ` ${summary}` : ""}`,
		);
	}

	async #onRpcError({ id, error }) {
		const elapsed = this.#starts.has(id)
			? `${((Date.now() - this.#starts.get(id)) / 1000).toFixed(1)}s`
			: "";
		this.#starts.delete(id);
		console.error(`[RPC] ✗ (${id}) ${elapsed} ${error?.message || error}`);
	}

	async #onStepCompleted(payload) {
		if (process.env.RUMMY_DEBUG !== "true") return;
		console.log(
			`[DEBUG] Turn ${payload.turn} completed for run ${payload.run}`,
		);
	}

	async #logMessages(messages, context) {
		this.#turnLog.push(
			`\n${"=".repeat(60)}\nTURN — model=${context.model} run=${context.runId}\n${"=".repeat(60)}`,
		);
		for (const msg of messages) {
			const label = msg.role.toUpperCase();
			const body =
				typeof msg.content === "string"
					? msg.content
					: JSON.stringify(msg.content);
			this.#turnLog.push(`\n--- ${label} ---\n${body}`);
		}
		return messages;
	}

	async #logResponse(response) {
		const msg = response.choices?.[0]?.message;
		this.#turnLog.push(`\n--- ASSISTANT ---\n${msg?.content || "(empty)"}`);
		if (msg?.reasoning_content) {
			this.#turnLog.push(`\n--- REASONING ---\n${msg.reasoning_content}`);
		}
		const usage = response.usage || {};
		this.#turnLog.push(`\n--- USAGE ---\n${JSON.stringify(usage)}`);
		this.#flush();
		return response;
	}

	#flush() {
		if (!this.#lastRunPath || this.#turnLog.length === 0) return;
		try {
			writeFileSync(this.#lastRunPath, `${this.#turnLog.join("\n")}\n`);
		} catch {
			// RUMMY_HOME may not exist yet
		}
	}
}
