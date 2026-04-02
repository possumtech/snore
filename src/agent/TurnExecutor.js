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
		mode,
		project,
		sessionId,
		currentRunId,
		currentAlias,
		requestedModel,
		loopPrompt,
		noContext,
		contextSize,
		options,
		signal,
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

		// Store prompt entries BEFORE context materialization
		// so v_model_context includes the current prompt
		if (loopPrompt && !options?.isContinuation) {
			// New prompt — create loop identity + payload
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`prompt://${turn}`,
				"",
				"info",
				{ meta: { mode } },
			);
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`${mode}://${turn}`,
				loopPrompt,
				"info",
			);
		} else if (loopPrompt) {
			// Continuation — progress entry
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`progress://${turn}`,
				loopPrompt,
				"info",
			);
		}

		// Build system prompt before hooks (static for the turn)
		const systemPrompt = await PromptManager.getSystemPrompt(mode, {
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
			type: mode,
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
		const toolNames = this.#hooks.tools.namesForMode(mode).join(" ");
		const messages = ContextAssembler.assembleFromTurnContext(rows, {
			type: mode,
			tools: toolNames,
		});

		const filteredMessages = await this.#hooks.llm.messages.filter(messages, {
			model: requestedModel,
			sessionId,
			runId: currentRunId,
		});

		// Store actual assembled messages as audit (full messages sent to model)
		const systemMsg = filteredMessages.find((m) => m.role === "system");
		const userMsg = filteredMessages.find((m) => m.role === "user");
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`system://${turn}`,
			systemMsg?.content || systemPrompt,
			"info",
		);
		if (userMsg) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`user://${turn}`,
				userMsg.content,
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
			{ temperature: options?.temperature, signal },
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

		// Store full assistant response as audit
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`assistant://${turn}`,
			content,
			"info",
		);

		await this.#hooks.run.progress.emit({
			sessionId,
			run: currentAlias,
			turn,
			status: "processing",
		});

		// Parse XML commands from content
		const { commands, unparsed } = XmlParser.parse(content);

		// Store raw API response diagnostics
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`model://${turn}`,
			JSON.stringify({
				keys: responseMessage ? Object.keys(responseMessage) : [],
				reasoning_content: responseMessage?.reasoning_content || null,
				content: content.slice(0, 4096),
				usage: result.usage || null,
				model: result.model || requestedModel,
			}),
			"info",
		);

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
		let actionCalls = [];
		let writeCalls = [];
		const unknownCalls = [];
		let summaryText = null;
		let updateText = null;
		let askUserCmd = null;

		for (const cmd of commands) {
			if (cmd.name === "summarize") summaryText = cmd.value;
			else if (cmd.name === "update") updateText = cmd.value;
			else if (cmd.name === "write" && (cmd.blocks || cmd.search))
				actionCalls.push(cmd);
			else if (cmd.name === "write") writeCalls.push(cmd);
			else if (cmd.name === "unknown") unknownCalls.push(cmd);
			else if (cmd.name === "ask_user") askUserCmd = cmd;
			else actionCalls.push(cmd);
		}

		const hasAct = actionCalls.some((c) =>
			["write", "delete", "run", "move", "copy"].includes(c.name),
		);
		const hasReads = actionCalls.some((c) =>
			["read", "env", "search"].includes(c.name),
		);
		const hasWrites = writeCalls.length > 0 || unknownCalls.length > 0;
		const flags = { hasAct, hasReads, hasWrites };

		// If model sent both, summary wins (terminates)
		if (summaryText && updateText) updateText = null;

		// If model sent neither, heal from content
		let statusHealed = false;
		if (!summaryText && !updateText) {
			const healed = ResponseHealer.healStatus(content, commands);
			summaryText = healed.summaryText;
			updateText = healed.updateText;
			statusHealed = true;
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

		// Step 0: Mode enforcement — reject prohibited commands in ask mode
		if (mode === "ask") {
			for (const cmd of [...actionCalls, ...writeCalls]) {
				if (cmd.name === "run") {
					console.warn(`[RUMMY] Rejected <run> in ask mode`);
					continue;
				}
				// File writes (scheme === null) are prohibited in ask mode
				if (cmd.name === "write" && cmd.path) {
					const scheme = KnownStore.scheme(cmd.path);
					if (scheme === null) {
						console.warn(
							`[RUMMY] Rejected file write to ${cmd.path} in ask mode`,
						);
						cmd._rejected = true;
					}
				}
				if (cmd.name === "delete" && cmd.path) {
					const scheme = KnownStore.scheme(cmd.path);
					if (scheme === null) {
						console.warn(
							`[RUMMY] Rejected file delete of ${cmd.path} in ask mode`,
						);
						cmd._rejected = true;
					}
				}
				if ((cmd.name === "move" || cmd.name === "copy") && cmd.to) {
					const destScheme = KnownStore.scheme(cmd.to);
					if (destScheme === null) {
						console.warn(
							`[RUMMY] Rejected ${cmd.name} to file ${cmd.to} in ask mode`,
						);
						cmd._rejected = true;
					}
				}
			}
			actionCalls = actionCalls.filter((c) => c.name !== "run" && !c._rejected);
			writeCalls = writeCalls.filter((c) => !c._rejected);
		}

		// Step 1: Action tools
		for (const cmd of actionCalls) {
			// keys flag — preview matches, no state change
			if (cmd.preview && cmd.path) {
				await this.#storeToolResult(currentRunId, turn, cmd, null, true);
				continue;
			}

			if (cmd.name === "read") {
				if (!cmd.path) continue;
				if (/^https?:\/\//.test(cmd.path)) {
					await this.#fetchUrl(currentRunId, turn, cmd.path);
				}
				const isPattern = cmd.value || cmd.path.includes("*");
				const matches = await this.#knownStore.getEntriesByPattern(
					currentRunId,
					cmd.path,
					cmd.value,
				);
				await this.#knownStore.promoteByPattern(
					currentRunId,
					cmd.path,
					cmd.value,
					turn,
				);
				if (isPattern) {
					await this.#storeToolResult(currentRunId, turn, cmd, matches);
				} else {
					const total = matches.reduce((s, m) => s + m.tokens_full, 0);
					const slug = `read://${cmd.path}`;
					const paths = matches.map((m) => m.path).join(", ");
					const content =
						matches.length > 0
							? `${paths} loaded in context (${total} tokens)`
							: `${cmd.path} not found`;
					await this.#knownStore.upsert(
						currentRunId,
						turn,
						slug,
						content,
						"read",
					);
				}
				continue;
			}
			if (cmd.name === "search") {
				if (!cmd.path) continue;
				await this.#processSearch(rummy, cmd.path, cmd.results);
				continue;
			}
			if (cmd.name === "store") {
				if (!cmd.path) continue;
				const isPattern = cmd.value || cmd.path.includes("*");
				const matches = await this.#knownStore.getEntriesByPattern(
					currentRunId,
					cmd.path,
					cmd.value,
				);
				await this.#knownStore.demoteByPattern(
					currentRunId,
					cmd.path,
					cmd.value,
				);
				if (isPattern) {
					await this.#storeToolResult(currentRunId, turn, cmd, matches);
				} else {
					const slug = `store://${cmd.path}`;
					const paths = matches.map((m) => m.path).join(", ");
					const content =
						matches.length > 0
							? `${paths} removed from context. Use <read> to restore.`
							: `${cmd.path} not found`;
					await this.#knownStore.upsert(
						currentRunId,
						turn,
						slug,
						content,
						"stored",
					);
				}
				continue;
			}

			if (cmd.name === "write") {
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

			// run, env, ask_user — single proposed/pass entry
			const resultPath = await this.#knownStore.slugPath(
				currentRunId,
				cmd.name,
				cmd.command || cmd.path || cmd.question || "",
			);
			cmd.resultPath = resultPath;
			const resultValue = cmd.command
				? `<${cmd.name}>${cmd.command}</${cmd.name}>`
				: "";
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				resultPath,
				resultValue,
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
			const resultPath = await this.#knownStore.slugPath(
				currentRunId,
				"ask_user",
				askUserCmd.question || "",
			);
			askUserCmd.resultPath = resultPath;
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				resultPath,
				askUserCmd.question || "",
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
				const unknownPath = await this.#knownStore.slugPath(
					currentRunId,
					"unknown",
					cmd.value,
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

		// Step 3: Write entries (plain upsert or bulk update)
		for (const cmd of writeCalls) {
			// Naked write — no path, generate known:// slug from content
			if (!cmd.path) {
				if (!cmd.value) continue;
				const sluggedPath = await this.#knownStore.slugPath(
					currentRunId,
					"known",
					cmd.value,
				);
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					sluggedPath,
					cmd.value,
					"full",
				);
				continue;
			}

			// keys flag — preview matches
			if (cmd.preview) {
				await this.#storeToolResult(currentRunId, turn, cmd, null, true);
				continue;
			}

			// Write to path — hedberg handles both literal and pattern paths
			const scheme = KnownStore.scheme(cmd.path);
			if (scheme === null) {
				// Bare file path → proposed for client review
				const resultPath = `write://${cmd.path}`;
				const tokenEst = ((cmd.value?.length || 0) / 4) | 0;
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					resultPath,
					`${cmd.path} (new file, ${tokenEst} tokens)`,
					"proposed",
					{
						meta: { file: cmd.path, content: cmd.value },
					},
				);
			} else if (cmd.filter || cmd.path.includes("*")) {
				// Pattern with wildcards → bulk update via hedberg
				const matches = await this.#knownStore.getEntriesByPattern(
					currentRunId,
					cmd.path,
					cmd.filter,
				);
				await this.#knownStore.updateValueByPattern(
					currentRunId,
					cmd.path,
					cmd.filter || null,
					cmd.value,
				);
				await this.#storeToolResult(currentRunId, turn, cmd, matches);
			} else {
				// Literal K/V path → immediate upsert
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					cmd.path,
					cmd.value,
					"full",
				);
			}
		}

		// Step 4: Status (summary terminates, update continues)
		if (summaryText) {
			const summaryPath = await this.#knownStore.slugPath(
				currentRunId,
				"summarize",
				summaryText,
			);
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				summaryPath,
				summaryText,
				"summary",
			);
		} else if (updateText) {
			const updatePath = await this.#knownStore.slugPath(
				currentRunId,
				"update",
				updateText,
			);
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				updatePath,
				updateText,
				"info",
			);
		}

		return {
			turn,
			turnId: turnRow.id,
			actionCalls,
			writeCalls,
			unknownCalls,
			summaryText,
			updateText,
			statusHealed,
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

	async #storeToolResult(runId, turn, cmd, matches, preview = false) {
		matches ??= await this.#knownStore.getEntriesByPattern(
			runId,
			cmd.path,
			cmd.value,
		);
		const scheme = cmd.name || "write";
		const slug = await this.#knownStore.slugPath(runId, scheme, cmd.path);
		const filter = cmd.value ? ` value="${cmd.value}"` : "";
		const total = matches.reduce((s, m) => s + m.tokens_full, 0);
		const listing = matches
			.map((m) => `${m.path} (${m.tokens_full})`)
			.join("\n");
		const prefix = preview ? "PREVIEW " : "";
		const content = `${prefix}${cmd.name} path="${cmd.path}"${filter}: ${matches.length} matched (${total} tokens)\n${listing}`;
		await this.#knownStore.upsert(runId, turn, slug, content, "pattern");
	}

	async #processEdit(runId, turn, cmd) {
		const matches = await this.#knownStore.getEntriesByPattern(
			runId,
			cmd.path,
			cmd.value,
		);

		if (matches.length === 0) {
			const resultPath = `write://${cmd.path}`;
			await this.#knownStore.upsert(
				runId,
				turn,
				resultPath,
				`${cmd.path} — not found in context. Use <read> to load it first.`,
				"error",
				{ meta: { file: cmd.path, error: "not found" } },
			);
			return;
		}

		for (const entry of matches) {
			const resultPath = `write://${entry.path}`;
			let patch = null;
			let warning = null;
			let error = null;
			let searchText = null;
			let replaceText = null;

			if (cmd.search != null) {
				// Attribute mode: search + replace (literal)
				searchText = cmd.search;
				replaceText = cmd.replace ?? "";
				const isRegex = /[+(){}|\\$^*?[\]]/.test(cmd.search);
				if (isRegex) {
					const re = new RegExp(cmd.search, "g");
					if (re.test(entry.value)) {
						patch = entry.value.replace(re, replaceText);
					} else {
						error = `Search pattern not found in ${entry.path}`;
					}
				} else if (entry.value.includes(cmd.search)) {
					patch = entry.value.replaceAll(cmd.search, replaceText);
				} else {
					error = `"${cmd.search}" not found in ${entry.path}`;
				}
			} else if (cmd.blocks?.length > 0 && cmd.blocks[0].search === null) {
				patch = cmd.blocks[0].replace;
				replaceText = cmd.blocks[0].replace;
			} else if (entry.value && cmd.blocks?.length > 0) {
				const block = cmd.blocks[0];
				searchText = block.search;
				replaceText = block.replace;
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

			// Compose result content: token delta + SEARCH/REPLACE block
			const beforeTokens = entry.tokens_full || 0;
			const afterTokens = patch ? (patch.length / 4) | 0 : beforeTokens;
			let content;
			if (error) {
				const block = searchText
					? `\n<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`
					: "";
				content = `${entry.path} — ${error}${block}`;
			} else if (searchText) {
				content = `${entry.path} (${beforeTokens} → ${afterTokens} tokens)\n<<<<<<< SEARCH\n${searchText}\n=======\n${replaceText}\n>>>>>>> REPLACE`;
			} else {
				content = `${entry.path} (${beforeTokens} → ${afterTokens} tokens)`;
			}

			await this.#knownStore.upsert(runId, turn, resultPath, content, state, {
				meta: {
					file: entry.path,
					search: cmd.search,
					replace: cmd.replace,
					blocks: cmd.blocks,
					patch,
					warning,
					error,
				},
			});

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
			const resultPath = `delete://${entry.path}`;
			const content = `rm ${entry.path}`;
			if (entry.scheme === null) {
				// File → proposed (client confirms deletion)
				await this.#knownStore.upsert(
					runId,
					turn,
					resultPath,
					content,
					"proposed",
					{
						meta: { path: entry.path },
					},
				);
			} else {
				// K/V → immediate remove
				await this.#knownStore.remove(runId, entry.path);
				await this.#knownStore.upsert(
					runId,
					turn,
					resultPath,
					content,
					"pass",
					{
						meta: { path: entry.path },
					},
				);
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

		const resultPath = `${cmd.name}://${cmd.path}`;

		// File destinations → proposed (client writes to disk)
		// K/V destinations → pass (immediate)
		const verb = isMove ? "mv" : "cp";
		const content = `${verb} ${cmd.path} ${cmd.to}`;
		if (destScheme === null) {
			await this.#knownStore.upsert(
				runId,
				turn,
				resultPath,
				content,
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
			await this.#knownStore.upsert(runId, turn, resultPath, content, "pass", {
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

	async #processSearch(rummy, query, maxResults) {
		await this.#hooks.action.search.filter(null, {
			query,
			limit: maxResults || 12,
			rummy,
		});
	}
}
