import ToolExtractor from "./ToolExtractor.js";
import ContextAssembler from "./ContextAssembler.js";
import FileScanner from "./FileScanner.js";
import ToolSchema from "../../domain/schema/ToolSchema.js";
import PromptManager from "../../domain/prompt/PromptManager.js";
import ProjectContext from "../../domain/project/ProjectContext.js";
import RummyContext from "../../domain/hooks/RummyContext.js";

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
			throw new Error(`Blocked: run has ${unresolved.length} unresolved proposed entries.`);
		}

		// Scan project files and sync to known store
		if (!noContext && project?.path) {
			const ctx = await ProjectContext.open(project.path);
			const files = await ctx.getMappableFiles();
			await this.#fileScanner.scan(project.path, project.id, files, turn);
		}

		// Run onTurn hooks
		const hookRoot = {
			tag: "turn", attrs: {}, content: null,
			children: [
				{ tag: "system", attrs: {}, content: null, children: [] },
				{ tag: "context", attrs: {}, content: null, children: [] },
				{ tag: "user", attrs: {}, content: null, children: [] },
				{ tag: "assistant", attrs: {}, content: null, children: [] },
			],
		};
		const rummy = new RummyContext(hookRoot, {
			db: this.#db, project, type, sequence: turn,
			runId: currentRunId, turnId: turnRow.id, noContext, contextSize,
		});
		await this.#hooks.processTurn(rummy);

		await this.#hooks.run.progress.emit({
			sessionId,
			run: currentAlias,
			turn,
			status: "thinking",
		});

		// Assemble context from known store
		const systemPrompt = await PromptManager.getSystemPrompt(type);
		const knownEntries = await this.#knownStore.getModelEntries(currentRunId, turn);
		const summaryLog = await this.#knownStore.getLog(currentRunId);
		const unknownEntry = (await this.#knownStore.getAll(currentRunId))
			.find((r) => r.key === "/:unknown");
		const unknownList = unknownEntry ? JSON.parse(unknownEntry.value || "[]") : [];

		const messages = ContextAssembler.assemble({
			systemPrompt,
			mode: type,
			knownEntries,
			unknownList,
			summaryLog,
			userMessage: loopPrompt,
		});

		const filteredMessages = await this.#hooks.llm.messages.filter(
			messages,
			{ model: requestedModel, sessionId, runId: currentRunId },
		);

		// DEBUG: dump what we're sending
		if (process.env.RUMMY_DEBUG === "true") {
			console.log("[DEBUG] Messages:", JSON.stringify(filteredMessages, null, 2));
		}

		// Call LLM with tool calling
		const result = await this.#llmProvider.completion(
			filteredMessages,
			requestedModel,
			{ temperature: options?.temperature, mode: type },
		);
		const responseMessage = result.choices?.[0]?.message;

		if (process.env.RUMMY_DEBUG === "true") {
			console.log("[DEBUG] Response tool_calls:", JSON.stringify(responseMessage?.tool_calls, null, 2));
			console.log("[DEBUG] Response content:", responseMessage?.content);
		}

		await this.#hooks.run.progress.emit({
			sessionId,
			run: currentAlias,
			turn,
			status: "processing",
		});

		// Extract and validate tool calls
		const extracted = ToolExtractor.extract(responseMessage);
		const { actionCalls, writeCalls, unknownCalls, summaryCall, promptCall, flags } = extracted;

		const validationError = ToolExtractor.validate({ summaryCall });
		if (validationError) throw new Error(validationError);

		// Validate tool arguments via AJV
		for (const tc of responseMessage.tool_calls || []) {
			const args = JSON.parse(tc.function?.arguments || "{}");
			const { valid, errors } = ToolSchema.validate(tc.function?.name, args);
			if (!valid) {
				throw new Error(`Invalid ${tc.function?.name} args: ${errors.map((e) => e.message).join(", ")}`);
			}
		}

		// Validate tool names for mode
		const toolNames = (responseMessage.tool_calls || []).map((tc) => tc.function?.name);
		const { valid: modeValid, invalid } = ToolSchema.validateMode(type, toolNames);
		if (!modeValid) {
			throw new Error(`Tools not allowed in ${type} mode: ${invalid.join(", ")}`);
		}

		// Commit usage stats
		const usage = result.usage || {};
		await this.#db.update_turn_stats.run({
			id: turnRow.id,
			prompt_tokens: Number(usage.prompt_tokens || 0),
			completion_tokens: Number(usage.completion_tokens || 0),
			total_tokens: Number(usage.total_tokens || 0),
			cost: Number(usage.cost || 0),
		});

		// Store reasoning as a known entry (hidden from model, audit only)
		if (responseMessage.reasoning_content) {
			await this.#knownStore.upsert(
				currentRunId, turn,
				`/:reasoning/${turn}`,
				responseMessage.reasoning_content,
				"info",
			);
		}

		// Store the system prompt and user message sent this turn (audit)
		await this.#knownStore.upsert(currentRunId, turn, `/:system/${turn}`, systemPrompt, "info");
		await this.#knownStore.upsert(currentRunId, turn, `/:user/${turn}`, loopPrompt, "info");

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

			// env, run, edit, delete — generate result keys
			const resultKey = await this.#knownStore.nextResultKey(currentRunId, call.name);
			call.resultKey = resultKey;

			const isProposed = call.name === "edit" || call.name === "run" || call.name === "delete";

			await this.#knownStore.upsert(
				currentRunId, turn, resultKey,
				"",
				isProposed ? "proposed" : "pass",
				{ meta: { ...call.args } },
			);
		}

		// Step 1b: Prompt (also proposed)
		if (promptCall) {
			const resultKey = await this.#knownStore.nextResultKey(currentRunId, "prompt");
			promptCall.resultKey = resultKey;
			await this.#knownStore.upsert(
				currentRunId, turn, resultKey,
				"",
				"proposed",
				{ meta: { ...promptCall.args } },
			);
		}

		// Step 2: Process unknowns
		if (unknownCalls.length > 0) {
			const items = unknownCalls.map((c) => c.args.text);
			await this.#knownStore.upsert(
				currentRunId, turn,
				"/:unknown",
				JSON.stringify(items),
				"full",
			);
		} else {
			await this.#knownStore.remove(currentRunId, "/:unknown");
		}

		// Step 3: Process writes
		for (const call of writeCalls) {
			await this.#knownStore.upsert(
				currentRunId, turn,
				call.args.key,
				call.args.value,
				"full",
			);
		}

		// Step 4: Store summary
		const summaryKey = await this.#knownStore.nextResultKey(currentRunId, "summary");
		await this.#knownStore.upsert(
			currentRunId, turn, summaryKey,
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
			promptCall,
			flags,
		};
	}
}
