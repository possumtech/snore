import msg from "../../domain/i18n/messages.js";
import Turn from "../../domain/turn/Turn.js";
import ToolExtractor from "./ToolExtractor.js";

export default class TurnExecutor {
	#db;
	#llmProvider;
	#hooks;
	#turnBuilder;

	constructor(db, llmProvider, hooks, turnBuilder) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
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

		// Fetch history (parent + current run)
		const historyMessages = [];
		if (parentRunId) {
			const parentRows = await this.#db.get_turn_history.all({
				run_id: parentRunId,
			});
			for (const row of parentRows) {
				if (!row.turn_id) continue;
				const turn = new Turn(this.#db, row.turn_id);
				await turn.hydrate();
				const msgs = await turn.serialize({ forHistory: true });
				historyMessages.push(...msgs);
			}
		}
		const historyRows = await this.#db.get_turn_history.all({
			run_id: currentRunId,
		});
		for (const row of historyRows) {
			if (!row.turn_id) continue;
			const turn = new Turn(this.#db, row.turn_id);
			await turn.hydrate();
			const msgs = await turn.serialize({ forHistory: true });
			historyMessages.push(...msgs);
		}

		// Create fresh turn in DB
		const turnRow = await this.#db.create_empty_turn.get({
			run_id: String(currentRunId || ""),
			sequence: Number(currentTurnSequence),
		});
		const turnId = turnRow.id;

		// Build turn context via TurnBuilder + plugins
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
			runId: currentRunId,
			turn: currentTurnSequence,
			status: "thinking",
		});

		// Serialize and call LLM (no prefill — structured output enforces schema)
		const currentTurnMessages = await turnObj.serialize();
		const newUserMsg = currentTurnMessages.find((m) => m.role === "user");
		const filteredMessages = await this.#hooks.llm.messages.filter(
			[
				...currentTurnMessages.filter((m) => m.role === "system"),
				...historyMessages,
				newUserMsg,
			].filter(Boolean),
			{ model: requestedModel, sessionId, runId: currentRunId },
		);

		const result = await this.#llmProvider.completion(
			filteredMessages,
			requestedModel,
			{ temperature: options?.temperature, mode: type },
		);
		const responseMessage = result.choices?.[0]?.message;
		const rawReasoning = responseMessage?.reasoning_content;
		const rawContent = responseMessage?.content || "";

		await this.#hooks.run.progress.emit({
			sessionId,
			runId: currentRunId,
			turn: currentTurnSequence,
			status: "processing",
		});

		const finalResponse = await this.#hooks.llm.response.filter(
			{
				...responseMessage,
				content: rawContent,
				reasoning_content: rawReasoning,
			},
			{ model: requestedModel, sessionId, runId: currentRunId },
		);

		// Parse structured JSON response (strip markdown code fences if present)
		let jsonContent = (finalResponse.content || "").trim();
		if (jsonContent.startsWith("```")) {
			jsonContent = jsonContent
				.replace(/^```(?:json)?\s*\n?/, "")
				.replace(/\n?```\s*$/, "");
		}
		const parsed = JSON.parse(jsonContent);

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

		// Commit assistant response to DB
		const elements = await this.#db.get_turn_elements.all({
			turn_id: turnId,
		});
		const assistantNode = elements.find((el) => el.tag_name === "assistant");
		if (!assistantNode) {
			throw new Error(msg("error.assistant_node_missing", { turnId }));
		}

		const commitTag = async (tagName, content, attrs = {}, sequence = 0) => {
			await this.#db.insert_turn_element.run({
				turn_id: turnId,
				parent_id: assistantNode.id,
				tag_name: String(tagName || ""),
				content: content === null ? null : String(content),
				attributes:
					typeof attrs === "string" ? attrs : JSON.stringify(attrs || {}),
				sequence: Number(sequence),
			});
		};

		if (finalResponse.reasoning_content) {
			await commitTag(
				"reasoning_content",
				finalResponse.reasoning_content,
				{},
				0,
			);
		}
		await commitTag("content", finalResponse.content, {}, 1);
		await commitTag(
			"meta",
			JSON.stringify({
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
			{},
			2,
		);

		// Commit structured fields as DB elements
		await commitTag("known", JSON.stringify(parsed.known || []), {}, 3);
		await commitTag("unknown", JSON.stringify(parsed.unknown || []), {}, 4);
		if (parsed.summary) {
			await commitTag("summary", parsed.summary, {}, 5);
		}

		// Extract tools from structured JSON
		const toolExtractor = new ToolExtractor(this.#hooks.tools);
		const { tools, flags } = toolExtractor.extract(parsed);

		await turnObj.hydrate();

		return {
			turnObj,
			turnId,
			turnSequence: currentTurnSequence,
			tools,
			structural: [
				{ name: "known", content: parsed.known || [] },
				{ name: "unknown", content: parsed.unknown || [] },
				...(parsed.summary
					? [{ name: "summary", content: parsed.summary }]
					: []),
			],
			flags,
			elements,
			finalResponse,
			turnJson: turnObj.toJson(),
			commitTag,
			parsedTodo: parsed.todo || [],
		};
	}
}
