import ToolExtractor from "./ToolExtractor.js";
import ContextAssembler from "./ContextAssembler.js";

export default class TurnExecutor {
	#db;
	#llmProvider;
	#hooks;
	#knownStore;
	#turnBuilder;

	constructor(db, llmProvider, hooks, knownStore, turnBuilder) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#knownStore = knownStore;
		this.#turnBuilder = turnBuilder;
	}

	#resolveAlias(modelId) {
		if (!modelId) return modelId;
		if (process.env[`RUMMY_MODEL_${modelId}`]) return modelId;
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("RUMMY_MODEL_") && process.env[key] === modelId)
				return key.replace("RUMMY_MODEL_", "");
		}
		return modelId;
	}

	async execute({
		type,
		project,
		sessionId,
		currentRunId,
		currentAlias,
		parentRunId,
		requestedModel,
		loopPrompt,
		noContext,
		contextSize,
		options,
	}) {
		// Determine turn sequence
		const lastSeqRow = await this.#db.get_last_turn_sequence.get({
			run_id: currentRunId,
		});
		const currentTurnSequence =
			lastSeqRow && lastSeqRow.last_seq !== null ? lastSeqRow.last_seq + 1 : 0;

		// Create turn in DB
		const turnRow = await this.#db.create_empty_turn.get({
			run_id: String(currentRunId || ""),
			sequence: Number(currentTurnSequence),
		});
		const turnId = turnRow.id;

		// Build turn context via TurnBuilder + plugins (for indexing, system prompt)
		const turnObj = await this.#turnBuilder.build({
			type,
			project,
			sessionId,
			model: requestedModel,
			db: this.#db,
			prompt: loopPrompt,
			sequence: Number(currentTurnSequence),
			hasUnknowns: true,
			todoComplete: false,
			turnId,
			runId: currentRunId,
			noContext,
			contextSize,
		});

		await this.#hooks.run.progress.emit({
			sessionId,
			run: currentAlias,
			turn: currentTurnSequence,
			status: "thinking",
		});

		// Assemble context from known store (no message history)
		const knownEntries = await this.#knownStore.getModelEntries(currentRunId);
		const summaryLog = await this.#knownStore.getLog(currentRunId);

		// Get previous turn's unknown list from known store
		// (stored as a /:unknown entry by the previous turn)
		const unknownEntry = (await this.#knownStore.getAll(currentRunId))
			.find((r) => r.key === "/:unknown");
		const unknownList = unknownEntry ? JSON.parse(unknownEntry.value || "[]") : [];

		// Get system prompt from turnObj
		const turnMessages = await turnObj.serialize();
		const systemPrompt = turnMessages.find((m) => m.role === "system")?.content || "";
		const userMessage = turnMessages.find((m) => m.role === "user")?.content || loopPrompt;

		const messages = ContextAssembler.assemble({
			systemPrompt,
			knownEntries,
			unknownList,
			summaryLog,
			userMessage,
		});

		const filteredMessages = await this.#hooks.llm.messages.filter(
			messages,
			{ model: requestedModel, sessionId, runId: currentRunId },
		);

		// Call LLM with tool calling
		const result = await this.#llmProvider.completion(
			filteredMessages,
			requestedModel,
			{ temperature: options?.temperature, mode: type },
		);
		const responseMessage = result.choices?.[0]?.message;

		await this.#hooks.run.progress.emit({
			sessionId,
			run: currentAlias,
			turn: currentTurnSequence,
			status: "processing",
		});

		// Extract tool calls
		const {
			actionCalls,
			knownCall,
			unknownCall,
			summaryCall,
			promptCall,
			flags,
		} = ToolExtractor.extract(responseMessage);

		// Validate required tools
		const validationError = ToolExtractor.validate({ knownCall, summaryCall });
		if (validationError) throw new Error(validationError);

		// Commit usage stats
		const usage = result.usage || {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
		};
		await this.#db.update_turn_stats.run({
			id: turnId,
			prompt_tokens: Number(usage.prompt_tokens || 0),
			completion_tokens: Number(usage.completion_tokens || 0),
			total_tokens: Number(usage.total_tokens || 0),
			cost: Number(usage.cost || 0),
		});

		// Commit tool calls to turn_elements
		const elements = await this.#db.get_turn_elements.all({ turn_id: turnId });
		const assistantNode = elements.find((el) => el.tag_name === "assistant");
		if (assistantNode) {
			let seq = 0;
			if (responseMessage.reasoning_content) {
				await this.#db.insert_turn_element.run({
					turn_id: turnId,
					parent_id: assistantNode.id,
					tag_name: "reasoning_content",
					content: responseMessage.reasoning_content,
					attributes: "{}",
					sequence: seq++,
				});
			}
			for (const tc of responseMessage.tool_calls || []) {
				await this.#db.insert_turn_element.run({
					turn_id: turnId,
					parent_id: assistantNode.id,
					tag_name: "tool_call",
					content: null,
					attributes: JSON.stringify({
						id: tc.id,
						name: tc.function?.name,
						arguments: tc.function?.arguments,
					}),
					sequence: seq++,
				});
			}
			await this.#db.insert_turn_element.run({
				turn_id: turnId,
				parent_id: assistantNode.id,
				tag_name: "meta",
				content: JSON.stringify({
					prompt_tokens: usage.prompt_tokens,
					completion_tokens: usage.completion_tokens,
					total_tokens: usage.total_tokens,
					cost: usage.cost || 0,
					temperature:
						options?.temperature ??
						Number.parseFloat(process.env.RUMMY_TEMPERATURE || "0.7"),
					alias: requestedModel,
					actualModel: result.model,
					displayModel: this.#resolveAlias(requestedModel),
				}),
				attributes: "{}",
				sequence: seq++,
			});
		}

		// --- SERVER EXECUTION ORDER ---
		// Step 1: Execute action tools, generate result keys
		for (const call of actionCalls) {
			const resultKey = await this.#knownStore.nextResultKey(currentRunId, call.name);
			call.resultKey = resultKey;

			// Store result entry as proposed (edits, commands) or pass (reads, drops)
			const isProposed = call.name === "edit" || call.name === "run" || call.name === "delete";
			const target = call.args.key || call.args.command || call.args.file || "";
			await this.#knownStore.upsert(
				currentRunId,
				turnId,
				resultKey,
				JSON.stringify(call.args),
				isProposed ? "proposed" : "pass",
				{ target, toolCallId: call.id },
			);
		}

		// Step 1b: Handle prompt separately (also proposed)
		if (promptCall) {
			const resultKey = await this.#knownStore.nextResultKey(currentRunId, "prompt");
			promptCall.resultKey = resultKey;
			await this.#knownStore.upsert(
				currentRunId,
				turnId,
				resultKey,
				JSON.stringify(promptCall.args),
				"proposed",
				{ target: promptCall.args.question || "", toolCallId: promptCall.id },
			);
		}

		// Step 2: Process unknown — store for next turn
		if (unknownCall) {
			await this.#knownStore.upsert(
				currentRunId,
				turnId,
				"/:unknown",
				JSON.stringify(unknownCall.args.items || []),
				"full",
			);
		} else {
			// Clear previous unknowns if model didn't call unknown
			await this.#knownStore.remove(currentRunId, "/:unknown");
		}

		// Step 3: UPSERT model's known entries
		for (const entry of knownCall.args.entries || []) {
			if (!entry.key) continue;
			if (entry.value === "") {
				await this.#knownStore.remove(currentRunId, entry.key);
			} else {
				await this.#knownStore.upsert(
					currentRunId,
					turnId,
					entry.key,
					entry.value,
					"full",
				);
			}
		}

		// Step 4: Store summary as a result entry
		const summaryKey = await this.#knownStore.nextResultKey(currentRunId, "summary");
		await this.#knownStore.upsert(
			currentRunId,
			turnId,
			summaryKey,
			summaryCall.args.text || "",
			"summary",
			{ toolCallId: summaryCall.id },
		);

		await turnObj.hydrate();

		return {
			turnObj,
			turnId,
			turnSequence: currentTurnSequence,
			actionCalls,
			knownCall,
			unknownCall,
			summaryCall,
			promptCall,
			flags,
			elements,
			responseMessage,
		};
	}
}
