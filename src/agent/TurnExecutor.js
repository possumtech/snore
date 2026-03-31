import ProjectContext from "../fs/ProjectContext.js";
import RummyContext from "../hooks/RummyContext.js";
import ContextAssembler from "./ContextAssembler.js";
import FileScanner from "./FileScanner.js";
import HeuristicMatcher from "./HeuristicMatcher.js";
import KnownStore from "./KnownStore.js";
import msg from "./messages.js";
import PromptManager from "./PromptManager.js";
import ResponseHealer from "./ResponseHealer.js";
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

		// Build system prompt before hooks (static for the turn)
		const systemPrompt = await PromptManager.getSystemPrompt(type, {
			db: this.#db,
			sessionId,
			hooks: this.#hooks,
		});

		// Run hooks — engine materializes turn_context at priority 20
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
			systemPrompt,
			loopPrompt,
		});
		await this.#hooks.processTurn(rummy);

		await this.#hooks.run.progress.emit({
			sessionId,
			run: currentAlias,
			turn,
			status: "thinking",
		});

		// Assemble context from materialized turn_context
		const rows = await this.#db.get_turn_context.all({
			run_id: currentRunId,
			turn,
		});
		const messages = ContextAssembler.assembleFromTurnContext(rows);

		const filteredMessages = await this.#hooks.llm.messages.filter(messages, {
			model: requestedModel,
			sessionId,
			runId: currentRunId,
		});

		// Store audit BEFORE LLM call
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`system://${turn}`,
			systemPrompt,
			"info",
		);
		if (loopPrompt) {
			const scheme = options?.isContinuation ? "prompt" : "user";
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`${scheme}://${turn}`,
				loopPrompt,
				"info",
			);
		}

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

		// Store reasoning (model thinking)
		if (responseMessage?.reasoning_content) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`reasoning://${turn}`,
				responseMessage.reasoning_content,
				"info",
			);
		}

		// Store content (unparsed assistant text)
		if (unparsed) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`content://${turn}`,
				unparsed,
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
			["edit", "delete", "run", "move", "copy"].includes(c.name),
		);
		const hasReads = actionCalls.some((c) =>
			["read", "env", "search"].includes(c.name),
		);
		const hasWrites = writeCalls.length > 0 || unknownCalls.length > 0;
		const flags = { hasAct, hasReads, hasWrites };

		summaryText = ResponseHealer.healSummary(summaryText, content, commands);

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
			// keys flag — preview matches, no state change
			if (cmd.keys && cmd.path) {
				const matches = await this.#knownStore.getEntriesByPattern(
					currentRunId,
					cmd.path,
					cmd.value,
				);
				const total = matches.reduce((sum, m) => sum + m.tokens_full, 0);
				const listing = matches
					.map((m) => `${m.path} (${m.tokens_full})`)
					.join("\n");
				const keysPath = await this.#knownStore.nextResultPath(
					currentRunId,
					"keys",
				);
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					keysPath,
					`${matches.length} paths (${total} tokens total)\n${listing}`,
					"info",
				);
				continue;
			}

			if (cmd.name === "read") {
				if (!cmd.path) continue;
				// URL fetch via plugin hook — download and store, then promote
				if (/^https?:\/\//.test(cmd.path)) {
					await this.#fetchUrl(currentRunId, turn, cmd.path);
				}
				await this.#knownStore.promoteByPattern(
					currentRunId,
					cmd.path,
					cmd.value,
					turn,
				);
				continue;
			}
			if (cmd.name === "search") {
				if (!cmd.path) continue;
				await this.#processSearch(currentRunId, turn, cmd.path);
				continue;
			}
			if (cmd.name === "drop") {
				if (!cmd.path) continue;
				await this.#knownStore.demoteByPattern(
					currentRunId,
					cmd.path,
					cmd.value,
				);
				continue;
			}

			if (cmd.name === "edit") {
				await this.#processEdit(currentRunId, turn, cmd);
				continue;
			}

			if (cmd.name === "delete") {
				await this.#processDelete(currentRunId, turn, cmd);
				continue;
			}

			if (cmd.name === "move" || cmd.name === "copy") {
				await this.#processMoveCopy(currentRunId, turn, cmd);
				continue;
			}

			// run, env — single proposed/pass entry
			const resultPath = await this.#knownStore.nextResultPath(
				currentRunId,
				cmd.name,
			);
			cmd.resultPath = resultPath;
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				resultPath,
				"",
				cmd.name === "env" ? "pass" : "proposed",
				{
					meta: {
						command: cmd.command,
						path: cmd.path,
						question: cmd.question,
						options: cmd.options,
					},
				},
			);
		}

		// Step 1b: ask_user
		if (askUserCmd) {
			const resultPath = await this.#knownStore.nextResultPath(
				currentRunId,
				"ask_user",
			);
			askUserCmd.resultPath = resultPath;
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				resultPath,
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
				const unknownPath = await this.#knownStore.nextResultPath(
					currentRunId,
					"unknown",
				);
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					unknownPath,
					cmd.value,
					"full",
				);
			}
		}

		// Step 3: Known entries
		for (const cmd of writeCalls) {
			if (!cmd.path) continue;

			// keys flag — preview matches
			if (cmd.keys) {
				const matches = await this.#knownStore.getEntriesByPattern(
					currentRunId,
					cmd.path,
					cmd.value,
				);
				const total = matches.reduce((sum, m) => sum + m.tokens_full, 0);
				const listing = matches
					.map((m) => `${m.path} (${m.tokens_full})`)
					.join("\n");
				const keysPath = await this.#knownStore.nextResultPath(
					currentRunId,
					"keys",
				);
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					keysPath,
					`${matches.length} paths (${total} tokens total)\n${listing}`,
					"info",
				);
				continue;
			}

			// Pattern-based bulk update or single upsert
			if (cmd.filter || /[*+?^${}()|[\]\\]/.test(cmd.path)) {
				await this.#knownStore.updateValueByPattern(
					currentRunId,
					cmd.path,
					cmd.filter || null,
					cmd.value,
				);
			} else {
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					cmd.path,
					cmd.value,
					"full",
				);
			}
		}

		// Step 4: Summary
		const summaryPath = await this.#knownStore.nextResultPath(
			currentRunId,
			"summary",
		);
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			summaryPath,
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

	async #processEdit(runId, turn, cmd) {
		const matches = await this.#knownStore.getEntriesByPattern(
			runId,
			cmd.path,
			cmd.value,
		);

		for (const entry of matches) {
			const resultPath = await this.#knownStore.nextResultPath(runId, "edit");
			let patch = null;
			let warning = null;
			let error = null;

			if (cmd.search != null) {
				// Attribute mode: search + replace (literal)
				const isRegex = /[+(){}|\\$^*?[\]]/.test(cmd.search);
				if (isRegex) {
					const re = new RegExp(cmd.search, "g");
					if (re.test(entry.value)) {
						patch = entry.value.replace(re, cmd.replace ?? "");
					} else {
						error = `Search pattern not found in ${entry.path}`;
					}
				} else if (entry.value.includes(cmd.search)) {
					patch = entry.value.replaceAll(cmd.search, cmd.replace ?? "");
				} else {
					error = `"${cmd.search}" not found in ${entry.path}`;
				}
			} else if (cmd.blocks?.length > 0 && cmd.blocks[0].search === null) {
				patch = cmd.blocks[0].replace;
			} else if (entry.value && cmd.blocks?.length > 0) {
				const block = cmd.blocks[0];
				const matched = HeuristicMatcher.matchAndPatch(
					entry.path,
					entry.value,
					block.search,
					block.replace,
				);
				patch = matched.patch;
				warning = matched.warning;
				error = matched.error;
			}

			// Files → proposed (client reviews). Keys → pass (immediate).
			const state = error
				? "error"
				: entry.scheme === null
					? "proposed"
					: "pass";

			await this.#knownStore.upsert(
				runId,
				turn,
				resultPath,
				patch || "",
				state,
				{
					meta: {
						file: entry.path,
						search: cmd.search,
						replace: cmd.replace,
						blocks: cmd.blocks,
						patch,
						warning,
						error,
					},
				},
			);

			// For non-file entries, apply the edit directly
			if (state === "pass" && patch) {
				await this.#knownStore.upsert(
					runId,
					turn,
					entry.path,
					patch,
					entry.state,
				);
			}
		}
	}

	async #processDelete(runId, turn, cmd) {
		const matches = await this.#knownStore.getEntriesByPattern(
			runId,
			cmd.path,
			cmd.value,
		);

		for (const entry of matches) {
			const resultPath = await this.#knownStore.nextResultPath(runId, "delete");

			if (entry.scheme === null) {
				// File → proposed (client confirms deletion)
				await this.#knownStore.upsert(runId, turn, resultPath, "", "proposed", {
					meta: { path: entry.path },
				});
			} else {
				// K/V → immediate remove
				await this.#knownStore.remove(runId, entry.path);
				await this.#knownStore.upsert(runId, turn, resultPath, "", "pass", {
					meta: { path: entry.path },
				});
			}
		}
	}

	async #processMoveCopy(runId, turn, cmd) {
		if (!cmd.path || !cmd.to) return;

		const source = await this.#knownStore.getValue(runId, cmd.path);
		if (source === null) return;

		const _sourceScheme = KnownStore.scheme(cmd.path);
		const destScheme = KnownStore.scheme(cmd.to);
		const isMove = cmd.name === "move";

		// Check for clobber on K/V targets
		const existing = await this.#knownStore.getValue(runId, cmd.to);
		let warning = null;
		if (existing !== null && destScheme !== null) {
			warning = `Overwrote existing entry at ${cmd.to}`;
		}

		const resultPath = await this.#knownStore.nextResultPath(runId, cmd.name);

		// File destinations → proposed (client writes to disk)
		// K/V destinations → pass (immediate)
		if (destScheme === null) {
			await this.#knownStore.upsert(
				runId,
				turn,
				resultPath,
				source,
				"proposed",
				{
					meta: { from: cmd.path, to: cmd.to, isMove, warning },
				},
			);
		} else {
			await this.#knownStore.upsert(runId, turn, cmd.to, source, "full");
			if (isMove) {
				await this.#knownStore.remove(runId, cmd.path);
			}
			await this.#knownStore.upsert(runId, turn, resultPath, "", "pass", {
				meta: { from: cmd.path, to: cmd.to, isMove, warning },
			});
		}
	}

	async #fetchUrl(runId, turn, rawUrl) {
		const url = rawUrl.replace(/[?#].*$/, "").replace(/\/$/, "");
		const existing = await this.#knownStore.getValue(runId, url);
		if (existing !== null) return;

		const result = await this.#hooks.action.fetch.filter(null, { url });
		if (!result) return;

		await this.#knownStore.upsert(
			runId,
			turn,
			result.url,
			result.value,
			"full",
			{
				meta: result.meta,
			},
		);
	}

	async #processSearch(runId, turn, query) {
		const result = await this.#hooks.action.search.filter(null, { query });
		if (!result) return;

		const resultPath = await this.#knownStore.nextResultPath(runId, "search");
		await this.#knownStore.upsert(
			runId,
			turn,
			resultPath,
			result.value,
			"info",
			{
				meta: result.meta,
			},
		);
	}
}
