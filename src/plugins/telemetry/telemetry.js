import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default class Telemetry {
	#core;
	#starts = new Map();
	#lastRunPath = null;
	#turnsDir = null;
	#turnLog = [];
	#currentRunAlias = null;
	#currentTurn = null;

	constructor(core) {
		this.#core = core;

		const home = process.env.RUMMY_HOME;
		if (home) {
			this.#lastRunPath = join(home, "last_run.txt");
			this.#turnsDir = join(home, "turns");
		}

		core.on("rpc.started", this.#onRpcStarted.bind(this));
		core.on("rpc.completed", this.#onRpcCompleted.bind(this));
		core.on("rpc.error", this.#onRpcError.bind(this));
		core.on("run.step.completed", this.#onStepCompleted.bind(this));
		core.on("turn.response", this.#onTurnResponse.bind(this));
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

	async #onTurnResponse({
		rummy,
		turn,
		result,
		responseMessage,
		content,
		unparsed,
		assembledTokens,
		systemMsg,
		userMsg,
	}) {
		const { entries: store, runId, loopId } = rummy;

		// assistant://N — the model's raw response
		await store.upsert(runId, turn, `assistant://${turn}`, content, 200, {
			loopId,
			fidelity: "archived",
		});

		// system://N, user://N — assembled messages as audit
		if (systemMsg) {
			await store.upsert(runId, turn, `system://${turn}`, systemMsg, 200, {
				loopId,
				fidelity: "archived",
			});
		}
		if (userMsg) {
			await store.upsert(runId, turn, `user://${turn}`, userMsg, 200, {
				loopId,
				fidelity: "archived",
			});
		}

		// model://N — raw API response diagnostics
		await store.upsert(
			runId,
			turn,
			`model://${turn}`,
			JSON.stringify({
				keys: responseMessage ? Object.keys(responseMessage) : [],
				reasoning_content: responseMessage?.reasoning_content || null,
				content: content.slice(0, 4096),
				usage: result.usage || null,
				model: result.model || null,
			}),
			200,
			{ loopId, fidelity: "archived" },
		);

		// reasoning://N
		if (responseMessage?.reasoning_content) {
			await store.upsert(
				runId,
				turn,
				`reasoning://${turn}`,
				responseMessage.reasoning_content,
				200,
				{ loopId, fidelity: "archived" },
			);
		}

		// content://N — unparsed text. 400 Bad Request because anything in
		// unparsed is text the parser couldn't dispatch (malformed XML, native
		// tool call attempts, reasoning bleed). Visible to the model so it
		// sees the rejection on its next turn and can correct.
		if (unparsed) {
			await store.upsert(runId, turn, `content://${turn}`, unparsed, 400, {
				loopId,
				fidelity: "promoted",
			});
		}

		// Commit usage stats
		const usage = result.usage || {};
		const cachedTokens =
			usage.cached_tokens ||
			usage.prompt_tokens_details?.cached_tokens ||
			usage.input_tokens_details?.cached_tokens ||
			usage.cache_read_input_tokens ||
			0;
		const reasoningTokens =
			usage.reasoning_tokens ||
			usage.completion_tokens_details?.reasoning_tokens ||
			usage.output_tokens_details?.reasoning_tokens ||
			0;
		// Use LLM's actual prompt_tokens as the ground-truth context size when available.
		// This back-fills context_tokens so get_last_context_tokens reflects reality for the next turn.
		const actualContextTokens = usage.prompt_tokens || assembledTokens || 0;
		await rummy.entries.updateTurnStats({
			id: rummy.turnId,
			context_tokens: actualContextTokens,
			reasoning_content: responseMessage?.reasoning_content || null,
			prompt_tokens: usage.prompt_tokens ?? 0,
			cached_tokens: cachedTokens ?? 0,
			completion_tokens: usage.completion_tokens ?? 0,
			reasoning_tokens: reasoningTokens ?? 0,
			total_tokens: usage.total_tokens ?? 0,
			cost: usage.cost ?? 0,
		});
	}

	async #logMessages(messages, context) {
		this.#currentRunAlias = context.runAlias || `run_${context.runId}`;
		this.#currentTurn = context.turn ?? null;
		this.#turnLog.push(
			`\n${"=".repeat(60)}\nTURN ${this.#currentTurn ?? "?"} — model=${context.model} run=${this.#currentRunAlias}\n${"=".repeat(60)}`,
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
		this.#writeTurnFile();
		return response;
	}

	#flush() {
		if (!this.#lastRunPath || this.#turnLog.length === 0) return;
		writeFile(this.#lastRunPath, `${this.#turnLog.join("\n")}\n`).catch(
			() => {},
		);
	}

	async #writeTurnFile() {
		if (!this.#turnsDir || !this.#currentRunAlias || this.#currentTurn == null)
			return;
		const runDir = join(this.#turnsDir, this.#currentRunAlias);
		try {
			await mkdir(runDir, { recursive: true });
			const fileName = `turn_${String(this.#currentTurn).padStart(3, "0")}.txt`;
			await writeFile(join(runDir, fileName), `${this.#turnLog.join("\n")}\n`);
		} catch {
			// best effort — diagnostic feature, don't fail the turn
		}
	}
}
