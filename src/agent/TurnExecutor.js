import ProjectContext from "../fs/ProjectContext.js";
import RummyContext from "../hooks/RummyContext.js";
import ContextAssembler from "./ContextAssembler.js";
import FileScanner from "./FileScanner.js";
import HeuristicMatcher, { generateUnifiedDiff } from "./HeuristicMatcher.js";
import PromptManager from "./PromptManager.js";
import ResponseHealer from "./ResponseHealer.js";

export default class TurnExecutor {
	#db;
	#llmProvider;
	#hooks;
	#knownStore;
	#fileScanner;

	constructor(db, llmProvider, hooks, knownStore) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#knownStore = knownStore;
		this.#fileScanner = new FileScanner(knownStore, db);
	}

	async execute({
		type,
		project,
		sessionId,
		currentRunId,
		currentAlias,
		requestedModel,
		loopPrompt,
		noContext,
		contextSize,
		options,
	}) {
		// Advance turn counter
		const turn = await this.#knownStore.nextTurn(currentRunId);

		// Create turn record for usage tracking
		const turnRow = await this.#db.create_turn.get({
			run_id: currentRunId,
			sequence: turn,
		});

		// Check state lock — no new turns while proposed entries exist
		const unresolved = await this.#knownStore.getUnresolved(currentRunId);
		if (unresolved.length > 0) {
			throw new Error(
				`Blocked: run has ${unresolved.length} unresolved proposed entries.`,
			);
		}

		// Scan project files and sync to known store
		if (!noContext && project?.path) {
			const ctx = await ProjectContext.open(project.path);
			const files = await ctx.getMappableFiles();
			await this.#fileScanner.scan(project.path, project.id, files, turn);
		}

		// Run onTurn hooks
		const hookRoot = {
			tag: "turn",
			attrs: {},
			content: null,
			children: [
				{ tag: "system", attrs: {}, content: null, children: [] },
				{ tag: "context", attrs: {}, content: null, children: [] },
				{ tag: "user", attrs: {}, content: null, children: [] },
				{ tag: "assistant", attrs: {}, content: null, children: [] },
			],
		};
		const rummy = new RummyContext(hookRoot, {
			db: this.#db,
			project,
			type,
			sequence: turn,
			runId: currentRunId,
			turnId: turnRow.id,
			noContext,
			contextSize,
		});
		await this.#hooks.processTurn(rummy);

		await this.#hooks.run.progress.emit({
			sessionId,
			run: currentAlias,
			turn,
			status: "thinking",
		});

		// Store user prompt as a known entry (visible to model at bottom of context)
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`/:prompt/${turn}`,
			loopPrompt,
			"info",
		);

		// Assemble context from known store — one ordered array
		const systemPrompt = await PromptManager.getSystemPrompt(type, {
			db: this.#db,
			sessionId,
		});
		const context = await this.#knownStore.getModelContext(currentRunId);

		const messages = ContextAssembler.assemble({
			systemPrompt,
			mode: type,
			context,
			userMessage: loopPrompt,
		});

		const filteredMessages = await this.#hooks.llm.messages.filter(messages, {
			model: requestedModel,
			sessionId,
			runId: currentRunId,
		});

		// DEBUG: dump what we're sending
		if (process.env.RUMMY_DEBUG === "true") {
			console.log(
				"[DEBUG] Messages:",
				JSON.stringify(filteredMessages, null, 2),
			);
		}

		// Call LLM with tool calling
		const result = await this.#llmProvider.completion(
			filteredMessages,
			requestedModel,
			{ temperature: options?.temperature, mode: type },
		);
		const responseMessage = result.choices?.[0]?.message;

		if (process.env.RUMMY_DEBUG === "true") {
			console.log(
				"[DEBUG] Response tool_calls:",
				JSON.stringify(responseMessage?.tool_calls, null, 2),
			);
			console.log("[DEBUG] Response content:", responseMessage?.content);
		}

		await this.#hooks.run.progress.emit({
			sessionId,
			run: currentAlias,
			turn,
			status: "processing",
		});

		// Heal and validate tool calls
		const { calls: healedCalls, warnings } = ResponseHealer.heal(
			responseMessage.tool_calls || [],
			type,
		);
		for (const w of warnings) console.warn(`[RUMMY] Healer: ${w}`);

		// Categorize healed calls
		const actionCalls = [];
		const writeCalls = [];
		const unknownCalls = [];
		let summaryCall = null;
		let askUserCall = null;

		for (const call of healedCalls) {
			if (call.name === "write") writeCalls.push(call);
			else if (call.name === "unknown") unknownCalls.push(call);
			else if (call.name === "summary") summaryCall = call;
			else if (call.name === "ask_user") askUserCall = call;
			else actionCalls.push(call);
		}

		const hasAct = actionCalls.some((c) =>
			["edit", "delete", "run"].includes(c.name),
		);
		const hasReads = actionCalls.some((c) => c.name === "read");
		const flags = { hasAct, hasReads };

		if (!summaryCall)
			throw new Error("Model response missing required 'summary' tool call.");

		// Capture any free-form content as reasoning (model may emit text alongside tools)
		const freeformContent = (responseMessage.content || "").trim();
		const reasoning = [responseMessage.reasoning_content, freeformContent]
			.filter(Boolean)
			.join("\n");

		// Commit usage stats
		const usage = result.usage || {};
		await this.#db.update_turn_stats.run({
			id: turnRow.id,
			prompt_tokens: Number(usage.prompt_tokens || 0),
			completion_tokens: Number(usage.completion_tokens || 0),
			total_tokens: Number(usage.total_tokens || 0),
			cost: Number(usage.cost || 0),
		});

		// Store reasoning (explicit + free-form content) as audit entry
		if (reasoning) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`/:reasoning/${turn}`,
				reasoning,
				"info",
			);
		}

		// Store the system prompt and user message sent this turn (audit)
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`/:system/${turn}`,
			systemPrompt,
			"info",
		);
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`/:user/${turn}`,
			loopPrompt,
			"info",
		);

		// --- SERVER EXECUTION ORDER ---

		// Step 1: Execute action tools
		for (const call of actionCalls) {
			if (call.name === "read") {
				await this.#knownStore.promote(currentRunId, call.args.key, turn);
				continue;
			}
			if (call.name === "drop") {
				await this.#knownStore.demote(currentRunId, call.args.key);
				continue;
			}

			const resultKey = await this.#knownStore.nextResultKey(
				currentRunId,
				call.name,
			);
			call.resultKey = resultKey;

			if (call.name === "edit") {
				// Compute patch from file content in known store
				const fileContent = await this.#knownStore.getValue(
					currentRunId,
					call.args.file,
				);
				let patch = null;
				let warning = null;
				let error = null;

				if (call.args.search === null) {
					// New file or full overwrite
					patch =
						call.args.search === null && fileContent
							? generateUnifiedDiff(
									call.args.file,
									fileContent,
									call.args.replace,
								)
							: null;
				} else if (fileContent !== null) {
					const result = HeuristicMatcher.matchAndPatch(
						call.args.file,
						fileContent,
						call.args.search,
						call.args.replace,
					);
					patch = result.patch;
					warning = result.warning;
					error = result.error;
				}

				await this.#knownStore.upsert(
					currentRunId,
					turn,
					resultKey,
					patch || "",
					error ? "error" : "proposed",
					{ meta: { ...call.args, patch, warning, error } },
				);
				call.patch = patch;
				call.warning = warning;
				call.error = error;
			} else {
				// env, run, delete
				const isProposed = call.name === "env" || call.name === "run" || call.name === "delete";
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					resultKey,
					"",
					isProposed ? "proposed" : "pass",
					{ meta: { ...call.args } },
				);
			}
		}

		// Step 1b: ask_user (also proposed)
		if (askUserCall) {
			const resultKey = await this.#knownStore.nextResultKey(
				currentRunId,
				"ask_user",
			);
			askUserCall.resultKey = resultKey;
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				resultKey,
				"",
				"proposed",
				{ meta: { ...askUserCall.args } },
			);
		}

		// Step 2: Process unknowns — sticky, deduplicated via SQL
		if (unknownCalls.length > 0) {
			const existingValues =
				await this.#knownStore.getUnknownValues(currentRunId);
			for (const call of unknownCalls) {
				if (existingValues.has(call.args.text)) continue;
				const key = await this.#knownStore.nextResultKey(
					currentRunId,
					"unknown",
				);
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					key,
					call.args.text,
					"full",
				);
			}
		}

		// Step 3: Process writes
		for (const call of writeCalls) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				call.args.key,
				call.args.value,
				"full",
			);
		}

		// Step 4: Store summary
		const summaryKey = await this.#knownStore.nextResultKey(
			currentRunId,
			"summary",
		);
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			summaryKey,
			summaryCall.args.text || "",
			"summary",
		);

		return {
			turn,
			turnId: turnRow.id,
			actionCalls,
			writeCalls,
			unknownCalls,
			summaryCall,
			askUserCall,
			flags,
			model: result.model || requestedModel,
			modelAlias: requestedModel,
			temperature:
				options?.temperature ??
				Number.parseFloat(process.env.RUMMY_TEMPERATURE || "0.7"),
			contextSize,
			usage,
		};
	}
}
