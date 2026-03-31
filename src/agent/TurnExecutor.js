import ProjectContext from "../fs/ProjectContext.js";
import RummyContext from "../hooks/RummyContext.js";
import ContextAssembler from "./ContextAssembler.js";
import FileScanner from "./FileScanner.js";
import HeuristicMatcher from "./HeuristicMatcher.js";
import msg from "./messages.js";
import PromptManager from "./PromptManager.js";
import XmlParser from "./XmlParser.js";

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
		this.#fileScanner = new FileScanner(knownStore, db, hooks);
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
		const turn = await this.#knownStore.nextTurn(currentRunId);

		const turnRow = await this.#db.create_turn.get({
			run_id: currentRunId,
			sequence: turn,
		});

		const unresolved = await this.#knownStore.getUnresolved(currentRunId);
		if (unresolved.length > 0) {
			throw new Error(
				msg("error.unresolved_proposed", { count: unresolved.length }),
			);
		}

		// File scan
		if (!noContext && project?.path) {
			const ctx = await ProjectContext.open(project.path);
			const files = await ctx.getMappableFiles();
			await this.#fileScanner.scan(project.path, project.id, files, turn);
		}

		// Run hooks
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
			store: this.#knownStore,
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

		// Assemble context
		const systemPrompt = await PromptManager.getSystemPrompt(type, {
			db: this.#db,
			sessionId,
		});
		const context = await this.#knownStore.getModelContext(currentRunId);
		const messages = ContextAssembler.assemble({
			systemPrompt,
			context,
			userMessage: loopPrompt,
		});

		const filteredMessages = await this.#hooks.llm.messages.filter(messages, {
			model: requestedModel,
			sessionId,
			runId: currentRunId,
		});

		// Store audit BEFORE LLM call
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`/:system:${turn}`,
			systemPrompt,
			"info",
		);
		if (loopPrompt && !options?.isContinuation) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`/:prompt:${turn}`,
				loopPrompt,
				"info",
			);
		}
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`/:user:${turn}`,
			loopPrompt || "",
			"info",
		);

		if (process.env.RUMMY_DEBUG === "true") {
			console.log(
				"[DEBUG] Messages:",
				JSON.stringify(filteredMessages, null, 2),
			);
		}

		// Call LLM
		await this.#hooks.llm.request.started.emit({ model: requestedModel, turn });
		const rawResult = await this.#llmProvider.completion(
			filteredMessages,
			requestedModel,
			{ temperature: options?.temperature },
		);
		const result = await this.#hooks.llm.response.filter(rawResult, {
			model: requestedModel,
			sessionId,
			runId: currentRunId,
		});
		await this.#hooks.llm.request.completed.emit({
			model: requestedModel,
			turn,
			usage: result.usage,
		});
		const responseMessage = result.choices?.[0]?.message;
		const content = responseMessage?.content || "";

		if (process.env.RUMMY_DEBUG === "true") {
			console.log("[DEBUG] Response content:", content.slice(0, 500));
		}

		await this.#hooks.run.progress.emit({
			sessionId,
			run: currentAlias,
			turn,
			status: "processing",
		});

		// Parse XML commands from content
		const { commands, unparsed } = XmlParser.parse(content);

		// Store reasoning (explicit reasoning + unparsed text)
		const reasoning = [responseMessage?.reasoning_content, unparsed]
			.filter(Boolean)
			.join("\n");
		if (reasoning) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`/:reasoning:${turn}`,
				reasoning,
				"info",
			);
		}

		// Categorize commands
		const actionCalls = [];
		const writeCalls = [];
		const unknownCalls = [];
		let summaryText = null;
		let askUserCmd = null;

		for (const cmd of commands) {
			if (cmd.name === "summary") summaryText = cmd.value;
			else if (cmd.name === "known") writeCalls.push(cmd);
			else if (cmd.name === "unknown") unknownCalls.push(cmd);
			else if (cmd.name === "ask_user") askUserCmd = cmd;
			else actionCalls.push(cmd);
		}

		const hasAct = actionCalls.some((c) =>
			["edit", "delete", "run"].includes(c.name),
		);
		const hasReads = actionCalls.some((c) => c.name === "read");
		const flags = { hasAct, hasReads };

		// Handle missing summary — always heal, never throw
		if (!summaryText) {
			const trimmed = content.trim();
			if (commands.length === 0 && trimmed) {
				// Plain text response — model skipped XML. Use as summary.
				console.warn("[RUMMY] Healed: plain text response used as summary");
				summaryText = trimmed.slice(0, 500);
			} else {
				// Empty response or commands without <summary> — inject placeholder
				console.warn(
					`[RUMMY] Healed: missing <summary>, injecting placeholder. Tools: ${commands.map((c) => c.name).join(", ") || "none"}`,
				);
				summaryText = "...";
			}
		}

		// Commit usage
		const usage = result.usage || {};
		await this.#db.update_turn_stats.run({
			id: turnRow.id,
			prompt_tokens: Number(usage.prompt_tokens || 0),
			completion_tokens: Number(usage.completion_tokens || 0),
			total_tokens: Number(usage.total_tokens || 0),
			cost: Number(usage.cost || 0),
		});

		// --- SERVER EXECUTION ORDER ---

		// Step 1: Action tools
		for (const cmd of actionCalls) {
			if (cmd.name === "read") {
				await this.#knownStore.promote(currentRunId, cmd.key, turn);
				continue;
			}
			if (cmd.name === "drop") {
				await this.#knownStore.demote(currentRunId, cmd.key);
				continue;
			}

			const resultKey = await this.#knownStore.nextResultKey(
				currentRunId,
				cmd.name,
			);
			cmd.resultKey = resultKey;
			const isProposed = ["edit", "run", "env", "delete"].includes(cmd.name);

			if (cmd.name === "edit") {
				const fileContent = await this.#knownStore.getValue(
					currentRunId,
					cmd.file,
				);
				let patch = null;
				let warning = null;
				let error = null;

				if (cmd.blocks?.length > 0 && cmd.blocks[0].search === null) {
					// New file
					patch = cmd.blocks[0].replace;
				} else if (fileContent !== null && cmd.blocks?.length > 0) {
					const block = cmd.blocks[0];
					const matched = HeuristicMatcher.matchAndPatch(
						cmd.file,
						fileContent,
						block.search,
						block.replace,
					);
					patch = matched.patch;
					warning = matched.warning;
					error = matched.error;
				}

				await this.#knownStore.upsert(
					currentRunId,
					turn,
					resultKey,
					patch || "",
					error ? "error" : "proposed",
					{
						meta: { file: cmd.file, blocks: cmd.blocks, patch, warning, error },
					},
				);
				cmd.patch = patch;
				cmd.warning = warning;
				cmd.error = error;
			} else {
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					resultKey,
					"",
					isProposed ? "proposed" : "pass",
					{
						meta: {
							command: cmd.command,
							key: cmd.key,
							question: cmd.question,
							options: cmd.options,
						},
					},
				);
			}
		}

		// Step 1b: ask_user
		if (askUserCmd) {
			const resultKey = await this.#knownStore.nextResultKey(
				currentRunId,
				"ask_user",
			);
			askUserCmd.resultKey = resultKey;
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				resultKey,
				"",
				"proposed",
				{
					meta: { question: askUserCmd.question, options: askUserCmd.options },
				},
			);
		}

		// Step 2: Unknowns — sticky, deduplicated
		if (unknownCalls.length > 0) {
			const existingValues =
				await this.#knownStore.getUnknownValues(currentRunId);
			for (const cmd of unknownCalls) {
				if (existingValues.has(cmd.value)) continue;
				const key = await this.#knownStore.nextResultKey(
					currentRunId,
					"unknown",
				);
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					key,
					cmd.value,
					"full",
				);
			}
		}

		// Step 3: Known entries
		for (const cmd of writeCalls) {
			if (!cmd.key) continue;
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				cmd.key,
				cmd.value,
				"full",
			);
		}

		// Step 4: Summary
		const summaryKey = await this.#knownStore.nextResultKey(
			currentRunId,
			"summary",
		);
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			summaryKey,
			summaryText,
			"summary",
		);

		// Async token recount — not on the hot path
		this.#knownStore.recountTokens(currentRunId, turn).catch((err) => {
			console.warn(`[RUMMY] Token recount failed: ${err.message}`);
		});

		return {
			turn,
			turnId: turnRow.id,
			actionCalls,
			writeCalls,
			unknownCalls,
			summaryText,
			askUserCmd,
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
