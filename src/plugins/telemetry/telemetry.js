import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// model://N is a diagnostic slice; full content is in assistant://N.
const MODEL_SNAPSHOT_BYTES = 4096;

export default class Telemetry {
	#core;
	#starts = new Map();
	#lastRunPath = null;
	#turnsDir = null;
	#turnLog = [];
	#turnStartIdx = 0;
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
		let summary = "";
		if (method === "set" && params?.path?.startsWith("run://")) {
			const prompt = params?.body ? params.body : "";
			summary = `prompt="${prompt.slice(0, 60)}"`;
		} else if (method === "run/abort") {
			summary = `run=${params?.run}`;
		} else if (method === "run/resolve") {
			summary = `run=${params?.run} action=${params?.resolution?.action}`;
		}
		console.log(`[RPC] → ${method}(${id})${summary ? ` ${summary}` : ""}`);
	}

	async #onRpcCompleted({ method, id, result }) {
		const elapsed = this.#starts.has(id)
			? `${((Date.now() - this.#starts.get(id)) / 1000).toFixed(1)}s`
			: "";
		this.#starts.delete(id);
		let summary = "";
		if (result?.run) {
			const status = result.status ? result.status : "ok";
			summary = `run=${result.run} status=${status}`;
		} else if (result?.status) {
			summary = `status=${result.status}`;
		}
		console.log(
			`[RPC] ← ${method}(${id}) ${elapsed}${summary ? ` ${summary}` : ""}`,
		);
	}

	async #onRpcError({ id, error }) {
		const elapsed = this.#starts.has(id)
			? `${((Date.now() - this.#starts.get(id)) / 1000).toFixed(1)}s`
			: "";
		this.#starts.delete(id);
		const detail = error?.message ? error.message : error;
		console.error(`[RPC] ✗ (${id}) ${elapsed} ${detail}`);
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
		// Audit schemes are system-only writes (see initPlugins).
		const systemOpts = { loopId, visibility: "archived", writer: "system" };

		// assistant://N — the model's raw response
		await store.set({
			runId,
			turn,
			path: `assistant://${turn}`,
			body: content,
			state: "resolved",
			...systemOpts,
		});

		// system://N, user://N — assembled messages as audit
		if (systemMsg) {
			await store.set({
				runId,
				turn,
				path: `system://${turn}`,
				body: systemMsg,
				state: "resolved",
				...systemOpts,
			});
		}
		if (userMsg) {
			await store.set({
				runId,
				turn,
				path: `user://${turn}`,
				body: userMsg,
				state: "resolved",
				...systemOpts,
			});
		}

		// model://N — raw API response diagnostics
		await store.set({
			runId,
			turn,
			path: `model://${turn}`,
			body: JSON.stringify({
				keys: responseMessage ? Object.keys(responseMessage) : [],
				reasoning_content: responseMessage?.reasoning_content
					? responseMessage.reasoning_content
					: null,
				content: content.slice(0, MODEL_SNAPSHOT_BYTES),
				usage: result.usage ? result.usage : null,
				model: result.model ? result.model : null,
			}),
			state: "resolved",
			...systemOpts,
		});

		// reasoning://N
		if (responseMessage?.reasoning_content) {
			await store.set({
				runId,
				turn,
				path: `reasoning://${turn}`,
				body: responseMessage.reasoning_content,
				state: "resolved",
				...systemOpts,
			});
			if (process.env.RUMMY_DEBUG === "true") {
				console.log(
					`\n--- REASONING turn ${turn} (${responseMessage.reasoning_content.length} chars) ---\n${responseMessage.reasoning_content}\n--- END REASONING turn ${turn} ---\n`,
				);
			}
		}

		// content://N — visible-rejected unparsed text so the model can correct next turn.
		if (unparsed) {
			await store.set({
				runId,
				turn,
				path: `content://${turn}`,
				body: unparsed,
				state: "failed",
				outcome: "unparsed",
				loopId,
				visibility: "visible",
				writer: "system",
			});
		}

		// Per-provider key drift; walk in priority order, 0 = not reported.
		const usage = result.usage ? result.usage : {};
		const cachedSources = [
			usage.cached_tokens,
			usage.prompt_tokens_details?.cached_tokens,
			usage.input_tokens_details?.cached_tokens,
			usage.cache_read_input_tokens,
		];
		const reasoningSources = [
			usage.reasoning_tokens,
			usage.completion_tokens_details?.reasoning_tokens,
			usage.output_tokens_details?.reasoning_tokens,
		];
		let cachedTokens = 0;
		for (const v of cachedSources)
			if (v) {
				cachedTokens = v;
				break;
			}
		let reasoningTokens = 0;
		for (const v of reasoningSources)
			if (v) {
				reasoningTokens = v;
				break;
			}
		// LLM's prompt_tokens is ground truth; estimator is pre-call fallback.
		let actualContextTokens = 0;
		if (usage.prompt_tokens) actualContextTokens = usage.prompt_tokens;
		else if (assembledTokens) actualContextTokens = assembledTokens;
		const numberOrZero = (v) => (typeof v === "number" ? v : 0);
		await rummy.entries.updateTurnStats({
			id: rummy.turnId,
			context_tokens: actualContextTokens,
			reasoning_content: responseMessage?.reasoning_content
				? responseMessage.reasoning_content
				: null,
			prompt_tokens: numberOrZero(usage.prompt_tokens),
			cached_tokens: cachedTokens,
			completion_tokens: numberOrZero(usage.completion_tokens),
			reasoning_tokens: reasoningTokens,
			total_tokens: numberOrZero(usage.total_tokens),
			// Cost surfaces under different field names by provider:
			// - OpenRouter direct: `usage.cost` (USD, what the relay billed us)
			// - OpenRouter BYOK: `usage.cost.upstream_inference_cost` (USD,
			//   relay didn't bill — upstream charged our key directly, so
			//   `usage.cost` is 0 and the true compute cost lives here).
			// - xAI direct: `usage.cost_in_usd_ticks` where 1 tick = 10⁻¹⁰
			//   USD (verified empirically: 11 uncached + 161 cached + 1
			//   output tokens → 107,500 ticks → $0.00001075 at xAI's
			//   $0.20/M input, $0.05/M cached, $0.50/M output rates).
			//   Divide by 1e10 to land in USD alongside the others.
			// All three normalized to USD; downstream summaries sum them
			// as comparable dollars.
			cost:
				numberOrZero(usage.cost) ||
				numberOrZero(usage.cost_details?.upstream_inference_cost) ||
				numberOrZero(usage.cost_in_usd_ticks) / 1e10,
		});
	}

	async #logMessages(messages, context) {
		const newAlias = context.runAlias
			? context.runAlias
			: `run_${context.runId}`;
		// Reset on alias change (the semantic run boundary).
		if (newAlias !== this.#currentRunAlias) {
			this.#turnLog = [];
		}
		this.#currentRunAlias = newAlias;
		this.#currentTurn = context.turn === undefined ? null : context.turn;
		// Per-turn slice index; turn_NNN.txt = this turn only, last_run.txt = cumulative.
		this.#turnStartIdx = this.#turnLog.length;
		const turnLabel = this.#currentTurn === null ? "?" : this.#currentTurn;
		this.#turnLog.push(
			`\n${"=".repeat(60)}\nTURN ${turnLabel} — model=${context.model} run=${this.#currentRunAlias}\n${"=".repeat(60)}`,
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
		const content = msg?.content ? msg.content : "(empty)";
		this.#turnLog.push(`\n--- ASSISTANT ---\n${content}`);
		if (msg?.reasoning_content) {
			this.#turnLog.push(`\n--- REASONING ---\n${msg.reasoning_content}`);
		}
		const usage = response.usage ? response.usage : {};
		this.#turnLog.push(`\n--- USAGE ---\n${JSON.stringify(usage)}`);
		this.#flush();
		this.#writeTurnFile();
		return response;
	}

	async #flush() {
		if (!this.#lastRunPath || this.#turnLog.length === 0) return;
		await writeFile(this.#lastRunPath, `${this.#turnLog.join("\n")}\n`);
	}

	async #writeTurnFile() {
		if (!this.#turnsDir || !this.#currentRunAlias || this.#currentTurn == null)
			return;
		const runDir = join(this.#turnsDir, this.#currentRunAlias);
		await mkdir(runDir, { recursive: true });
		const fileName = `turn_${String(this.#currentTurn).padStart(3, "0")}.txt`;
		const turnSlice = this.#turnLog.slice(this.#turnStartIdx);
		await writeFile(join(runDir, fileName), `${turnSlice.join("\n")}\n`);
	}
}
