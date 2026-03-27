import Turn from "../../domain/turn/Turn.js";
import TodoParser from "./TodoParser.js";
import ToolExtractor from "./ToolExtractor.js";

export default class TurnExecutor {
	#db;
	#llmProvider;
	#hooks;
	#turnBuilder;
	#responseParser;

	constructor(db, llmProvider, hooks, turnBuilder, responseParser) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#turnBuilder = turnBuilder;
		this.#responseParser = responseParser;
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

	#buildPrefill(processedItems) {
		if (processedItems.length === 0) return "<todo>\n- [ ] ";
		const checked = processedItems
			.map((item) => `- [x] ${item.tool}: ${item.argument}`)
			.join("\n");
		return `<todo>\n${checked}\n- [ ] `;
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
		processedItems,
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

		// Peek at last turn state
		let hasUnknowns = true;
		let todoComplete = false;
		const lastTurnRow = historyRows.at(-1);
		if (lastTurnRow) {
			const lastTurn = new Turn(this.#db, lastTurnRow.turn_id);
			await lastTurn.hydrate();
			const lastJson = lastTurn.toJson();
			const unknownText = (lastJson.assistant.unknown || "")
				.trim()
				.replace(/^[-*]\s*/, "");
			hasUnknowns =
				unknownText.length > 0 &&
				!/^(none\.?|n\/a|nothing\.?|-)$/i.test(unknownText) &&
				!/^<unknown\s*\/>$/i.test(unknownText) &&
				!/^<unknown\s*>\s*<\/unknown\s*>$/i.test(unknownText);
			todoComplete =
				lastJson.assistant.todo.length > 0 &&
				lastJson.assistant.todo.every((t) => t.completed);
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
			hasUnknowns,
			todoComplete,
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

		// Serialize and call LLM
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

		const prefill = this.#buildPrefill(processedItems);
		const result = await this.#llmProvider.completion(
			[...filteredMessages, { role: "assistant", content: prefill }],
			requestedModel,
			{ temperature: options?.temperature },
		);
		const responseMessage = result.choices?.[0]?.message;
		const rawReasoning = responseMessage?.reasoning_content;
		const mergedContent = this.#responseParser.mergePrefill(
			prefill,
			responseMessage?.content || "",
		);

		await this.#hooks.run.progress.emit({
			sessionId,
			runId: currentRunId,
			turn: currentTurnSequence,
			status: "processing",
		});

		const finalResponse = await this.#hooks.llm.response.filter(
			{
				...responseMessage,
				content: mergedContent,
				reasoning_content: rawReasoning,
			},
			{ model: requestedModel, sessionId, runId: currentRunId },
		);

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
			throw new Error(
				`Critical Error: assistant node not found in database for turn ${turnId}`,
			);
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
				alias: requestedModel,
				actualModel: result.model,
				displayModel: this.#resolveAlias(requestedModel),
			}),
			{},
			2,
		);

		// Parse response and extract tools
		const tags = this.#responseParser.parseActionTags(finalResponse.content);
		const todoTag = tags.find((t) => t.tagName === "todo");
		const todoContent = todoTag
			? this.#responseParser.getNodeText(todoTag)
			: "";
		const { list: parsedTodo } = TodoParser.parse(todoContent);

		const toolExtractor = new ToolExtractor(
			this.#responseParser,
			this.#hooks.tools,
		);
		const { tools, structural, flags } = toolExtractor.extract(
			tags,
			parsedTodo,
		);

		// Accumulate processed items for continuation prefill
		const newProcessedItems = [...processedItems];
		for (const item of parsedTodo) {
			if (!item.completed && item.tool) {
				newProcessedItems.push({ tool: item.tool, argument: item.argument });
			}
		}

		// Commit structural tags
		for (let i = 0; i < structural.length; i++) {
			await commitTag(structural[i].name, structural[i].content, {}, i + 3);
		}

		await turnObj.hydrate();

		// Protocol validation
		const validationErrors = await this.#validate(
			type,
			hasUnknowns,
			tags,
			turnObj,
			elements,
			turnId,
		);

		return {
			turnObj,
			turnId,
			turnSequence: currentTurnSequence,
			tools,
			structural,
			flags,
			elements,
			processedItems: newProcessedItems,
			finalResponse,
			turnJson: turnObj.toJson(),
			validationErrors,
			commitTag,
			parsedTodo,
			tags,
		};
	}

	async #validate(type, hasUnknowns, tags, _turnObj, _elements, _turnId) {
		const validationErrors = [];
		const constraints = await this.#db.get_protocol_constraints.get({
			type,
			has_unknowns: hasUnknowns ? 1 : 0,
		});
		if (!constraints) return validationErrors;

		const required = constraints.required_tags.split(/\s+/).filter(Boolean);
		const allowed = constraints.allowed_tags.split(/\s+/).filter(Boolean);
		const presentTags = new Set(tags.map((t) => t.tagName));

		for (const req of required) {
			if (!presentTags.has(req)) {
				validationErrors.push({
					content: `Missing required tag: <${req}>`,
					attrs: { protocol: "violation" },
				});
			}
		}
		for (const tag of tags) {
			if (!allowed.includes(tag.tagName)) {
				validationErrors.push({
					content: `Disallowed tag used: <${tag.tagName}>`,
					attrs: { protocol: "violation" },
				});
			}
		}

		return validationErrors;
	}
}
