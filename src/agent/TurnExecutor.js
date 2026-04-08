import RummyContext from "../hooks/RummyContext.js";
import ContextAssembler from "./ContextAssembler.js";
import KnownStore from "./KnownStore.js";
import msg from "./messages.js";
import ResponseHealer from "./ResponseHealer.js";
import { countTokens } from "./tokens.js";
import XmlParser from "./XmlParser.js";

export default class TurnExecutor {
	#db;
	#llmProvider;
	#hooks;
	#knownStore;

	constructor(db, llmProvider, hooks, knownStore) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#knownStore = knownStore;
	}

	async execute({
		mode,
		project,
		projectId,
		currentRunId,
		currentAlias,
		currentLoopId,
		requestedModel,
		loopPrompt,
		noContext,
		toolSet,
		contextSize,
		options,
		signal,
	}) {
		const turn = await this.#knownStore.nextTurn(currentRunId);

		const turnRow = await this.#db.create_turn.get({
			run_id: currentRunId,
			loop_id: currentLoopId,
			sequence: turn,
		});

		const unresolved = await this.#knownStore.getUnresolved(currentRunId);
		if (unresolved.length > 0) {
			throw new Error(
				msg("error.unresolved_proposed", { count: unresolved.length }),
			);
		}

		// Build RummyContext before turn.started so plugins can write entries
		const rummy = new RummyContext(
			{
				tag: "turn",
				attrs: {},
				content: null,
				children: [
					{ tag: "system", attrs: {}, content: null, children: [] },
					{ tag: "context", attrs: {}, content: null, children: [] },
					{ tag: "user", attrs: {}, content: null, children: [] },
					{ tag: "assistant", attrs: {}, content: null, children: [] },
				],
			},
			{
				hooks: this.#hooks,
				db: this.#db,
				store: this.#knownStore,
				project,
				type: mode,
				sequence: turn,
				runId: currentRunId,
				loopId: currentLoopId,
				turnId: turnRow.id,
				noContext,
				toolSet,
				contextSize,
				systemPrompt: null,
				loopPrompt,
			},
		);
		// Plugins write prompt/progress/instructions entries
		await this.#hooks.turn.started.emit({
			rummy,
			mode,
			prompt: loopPrompt,
			isContinuation: options?.isContinuation,
		});

		await this.#hooks.processTurn(rummy);

		// Project instructions://system through the instructions tool's projection
		const instrEntry = await this.#knownStore.getEntriesByPattern(
			currentRunId,
			"instructions://system",
			null,
		);
		const instrAttrs = instrEntry[0]
			? await this.#knownStore.getAttributes(
					currentRunId,
					"instructions://system",
				)
			: null;
		const systemPrompt = await this.#hooks.tools.view("instructions", {
			path: "instructions://system",
			scheme: "instructions",
			body: instrEntry[0]?.body || "",
			attributes: instrAttrs,
			fidelity: "full",
			category: "system",
		});

		// Materialize turn_context: VIEW rows projected through tools
		await this.#db.clear_turn_context.run({ run_id: currentRunId, turn });
		const viewRows = await this.#db.get_model_context.all({
			run_id: currentRunId,
		});
		for (const row of viewRows) {
			const scheme = row.scheme || "file";
			const projectedBody = await this.#hooks.tools.view(scheme, {
				path: row.path,
				scheme,
				body: row.body,
				attributes: row.attributes ? JSON.parse(row.attributes) : null,
				fidelity: row.fidelity,
				category: row.category,
			});

			await this.#db.insert_turn_context.run({
				run_id: currentRunId,
				loop_id: currentLoopId,
				turn,
				ordinal: row.ordinal,
				path: row.path,
				fidelity: row.fidelity,
				status: row.status,
				body: projectedBody ?? "",
				tokens: countTokens(projectedBody ?? ""),
				attributes: row.attributes,
				category: row.category,
				source_turn: row.turn,
			});
		}

		const demoted = [];

		await this.#hooks.run.progress.emit({
			projectId,
			run: currentAlias,
			turn,
			status: "thinking",
		});

		let rows = await this.#db.get_turn_context.all({
			run_id: currentRunId,
			turn,
		});
		let messages = await ContextAssembler.assembleFromTurnContext(
			rows,
			{ type: mode, systemPrompt, contextSize, demoted, toolSet },
			this.#hooks,
		);

		const budgetResult = await this.#hooks.budget.enforce({
			contextSize,
			store: this.#knownStore,
			runId: currentRunId,
			loopId: currentLoopId,
			turn,
			messages,
			rows,
			rematerialize: async () => {
				await this.#rematerialize(currentRunId, currentLoopId, turn);
				rows = await this.#db.get_turn_context.all({
					run_id: currentRunId,
					turn,
				});
				messages = await ContextAssembler.assembleFromTurnContext(
					rows,
					{ type: mode, systemPrompt, contextSize, demoted, toolSet },
					this.#hooks,
				);
				return { messages, rows };
			},
			summarize: async (entries) => {
				await this.#hooks.cascade.summarize.emit({
					entries,
					runId: currentRunId,
					model: requestedModel,
					store: this.#knownStore,
					contextSize,
					complete: async (msgs) =>
						this.#llmProvider.completion(msgs, requestedModel),
				});
			},
		});
		messages = budgetResult.messages;
		rows = budgetResult.rows;
		demoted.push(...budgetResult.demoted);

		let filteredMessages = await this.#hooks.llm.messages.filter(messages, {
			model: requestedModel,
			projectId,
			runId: currentRunId,
		});

		// Call LLM
		await this.#hooks.llm.request.started.emit({ model: requestedModel, turn });
		let rawResult;
		const isTransient = (e) =>
			/\b(503|429|timeout|ECONNREFUSED|ECONNRESET|unavailable)\b/i.test(
				e.message,
			);

		for (let llmAttempt = 0; ; llmAttempt++) {
			try {
				rawResult = await this.#llmProvider.completion(
					filteredMessages,
					requestedModel,
					{ temperature: options?.temperature, signal },
				);
				break;
			} catch (err) {
				if (isTransient(err) && llmAttempt < 3) {
					const delay = 1000 * 2 ** llmAttempt;
					console.warn(
						`[RUMMY] Transient LLM error (attempt ${llmAttempt + 1}/3): ${err.message.slice(0, 120)}. Retrying in ${delay}ms.`,
					);
					await new Promise((r) => setTimeout(r, delay));
					continue;
				}
				if (!err.message?.includes("exceed")) throw err;

				// Emergency retry — cascade missed due to tokenizer mismatch.
				// Demote largest remaining full entries one at a time until it fits.
				console.warn("[RUMMY] Context overflow from LLM — emergency demotion");
				for (let attempt = 0; attempt < 10; attempt++) {
					const candidate = rows
						.filter(
							(r) =>
								r.fidelity === "full" &&
								r.tokens > 0 &&
								r.category !== "prompt" &&
								!demoted.includes(r.path),
						)
						.toSorted((a, b) => b.tokens - a.tokens)[0];

					if (!candidate) throw err;
					await this.#knownStore.setFidelity(
						currentRunId,
						candidate.path,
						"summary",
					);
					demoted.push(candidate.path);

					await this.#rematerialize(currentRunId, currentLoopId, turn);
					rows = await this.#db.get_turn_context.all({
						run_id: currentRunId,
						turn,
					});
					messages = await ContextAssembler.assembleFromTurnContext(
						rows,
						{ type: mode, systemPrompt, contextSize, demoted, toolSet },
						this.#hooks,
					);
					filteredMessages = await this.#hooks.llm.messages.filter(messages, {
						model: requestedModel,
						projectId,
						runId: currentRunId,
					});

					try {
						rawResult = await this.#llmProvider.completion(
							filteredMessages,
							requestedModel,
							{ temperature: options?.temperature, signal },
						);
						console.warn(
							`[RUMMY] Emergency demotion: ${attempt + 1} entries demoted. Retry succeeded.`,
						);
						break;
					} catch (retryErr) {
						if (!retryErr.message?.includes("exceed")) throw retryErr;
					}
				}
				if (!rawResult) throw err;
			}
		}
		const result = await this.#hooks.llm.response.filter(rawResult, {
			model: requestedModel,
			projectId,
			runId: currentRunId,
		});
		await this.#hooks.llm.request.completed.emit({
			model: requestedModel,
			turn,
			usage: result.usage,
		});
		const responseMessage = result.choices?.[0]?.message;
		const content = responseMessage?.content || "";

		await this.#hooks.run.progress.emit({
			projectId,
			run: currentAlias,
			turn,
			status: "processing",
		});

		// Parse and emit — plugins handle audit storage
		const { commands, unparsed } = XmlParser.parse(content);

		const systemMsg = filteredMessages.find((m) => m.role === "system");
		const userMsg = filteredMessages.find((m) => m.role === "user");
		await this.#hooks.turn.response.emit({
			rummy,
			turn,
			result,
			responseMessage,
			content,
			commands,
			unparsed,
			systemMsg: systemMsg?.content,
			userMsg: userMsg?.content,
		});

		// --- PHASE 1: RECORD ---
		// Split lifecycle signals from action commands.
		// Lifecycle signals (summarize, update, unknown, known) are state
		// declarations — always recorded, never 409'd by sequential dispatch.
		const LIFECYCLE = new Set(["summarize", "update", "unknown", "known"]);

		const recorded = [];
		const lifecycle = [];
		const actions = [];

		// Track budget headroom for 413 rejection during recording.
		// Use assembled message tokens (includes system prompt overhead).
		const budgetCeiling = contextSize ? contextSize * 0.95 : null;
		const currentBudgetUsed = budgetCeiling
			? messages.reduce((sum, m) => sum + countTokens(m.content || ""), 0)
			: 0;
		let budgetRemaining = budgetCeiling
			? budgetCeiling - currentBudgetUsed
			: Infinity;

		for (const cmd of commands) {
			const entry = await this.#record(
				currentRunId,
				currentLoopId,
				turn,
				mode,
				cmd,
				budgetRemaining,
			);
			if (!entry) continue;
			recorded.push(entry);

			if (LIFECYCLE.has(entry.scheme)) {
				lifecycle.push(entry);
			} else {
				actions.push(entry);
			}

			if (entry.body && budgetCeiling) {
				budgetRemaining -= countTokens(entry.body);
			}
		}

		// --- PHASE 2: DISPATCH ---
		// Lifecycle signals first — always dispatched, never aborted.
		for (const entry of lifecycle) {
			await this.#hooks.tools.dispatch(entry.scheme, entry, rummy);
			await this.#hooks.entry.created.emit(entry);
		}

		// Action commands: sequential, stop on proposal or error.
		let hasErrors = false;
		let hasProposed = false;
		let abortAfter = null;
		const dispatched = [...lifecycle];

		for (const entry of actions) {
			if (abortAfter) {
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					entry.resultPath || entry.path,
					"",
					409,
					{
						attributes: {
							error: `Aborted — preceding <${abortAfter}> requires resolution.`,
						},
						loopId: currentLoopId,
					},
				);
				hasErrors = true;
				continue;
			}

			await this.#hooks.tools.dispatch(entry.scheme, entry, rummy);
			await this.#hooks.entry.created.emit(entry);
			dispatched.push(entry);

			const row = await this.#db.get_entry_state.get({
				run_id: currentRunId,
				path: entry.resultPath || entry.path,
			});
			if (row?.status === 202) {
				hasProposed = true;
				abortAfter = entry.scheme;
			} else if (row?.status >= 400) {
				hasErrors = true;
				abortAfter = entry.scheme;
			}
		}

		// Materialize proposals only if we dispatched actions
		if (!abortAfter || hasProposed) {
			await this.#hooks.turn.proposing.emit({ rummy, recorded: dispatched });
		}

		// Recheck after materialization (set handler may create proposals)
		if (!hasProposed && !hasErrors) {
			for (const entry of actions) {
				const row = await this.#db.get_entry_state.get({
					run_id: currentRunId,
					path: entry.resultPath || entry.path,
				});
				if (row?.status === 202) hasProposed = true;
				if (row?.status >= 400) hasErrors = true;
			}
		}

		// Lifecycle signals are always available — never 409'd.
		const summaryEntry = lifecycle.find((e) => e.scheme === "summarize");
		const updateEntry = lifecycle.find((e) => e.scheme === "update");
		let summaryText = summaryEntry?.body || null;
		let updateText = updateEntry?.body || null;

		// If model sent both, summary wins
		if (summaryText && updateText) updateText = null;

		// If model says "done" but actions failed, override — the model's
		// assertion that it's done is false if it failed to do what it tried.
		if (summaryText && hasErrors) {
			console.warn(
				"[RUMMY] Overriding <summarize> — actions in this turn failed. Continuing.",
			);
			updateText = summaryText;
			summaryText = null;
		}

		// If model sent neither, heal from content
		let statusHealed = false;
		if (!summaryText && !updateText) {
			const healed = ResponseHealer.healStatus(content, commands);
			summaryText = healed.summaryText;
			updateText = healed.updateText;
			statusHealed = true;
		}

		// --- Classify for return value ---

		const actionCalls = recorded.filter((e) =>
			["get", "set", "rm", "mv", "cp", "sh", "env", "search"].includes(
				e.scheme,
			),
		);
		const writeCalls = recorded.filter(
			(e) =>
				e.scheme === "known" ||
				(e.scheme === "set" && !e.attributes?.blocks && !e.attributes?.search),
		);
		const unknownCalls = recorded.filter((e) => e.scheme === "unknown");

		const hasAct = actionCalls.some((c) =>
			["set", "rm", "sh", "mv", "cp"].includes(c.scheme),
		);
		const hasReads = actionCalls.some((c) =>
			["get", "env", "search"].includes(c.scheme),
		);
		const hasWrites = writeCalls.length > 0 || unknownCalls.length > 0;
		const flags = { hasAct, hasReads, hasWrites };

		const askUserEntry = recorded.find((e) => e.scheme === "ask_user");

		return {
			turn,
			turnId: turnRow.id,
			actionCalls,
			writeCalls,
			unknownCalls,
			summaryText,
			updateText,
			statusHealed,
			askUserCmd: askUserEntry || null,
			flags,
			model: result.model || requestedModel,
			modelAlias: requestedModel,
			temperature:
				options?.temperature ??
				Number.parseFloat(process.env.RUMMY_TEMPERATURE || "0.7"),
			contextSize,
			usage: result.usage,
		};
	}

	/**
	 * Record a parsed command as a known_entries row.
	 * Returns the recorded entry descriptor, or null if rejected/skipped.
	 */
	async #record(runId, loopId, turn, mode, cmd, budgetRemaining = Infinity) {
		// Mode enforcement — reject prohibited commands in ask mode
		if (mode === "ask") {
			if (cmd.name === "sh") {
				console.warn("[RUMMY] Rejected <sh> in ask mode");
				return null;
			}
			if (cmd.name === "set" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) {
					console.warn(`[RUMMY] Rejected file set to ${cmd.path} in ask mode`);
					return null;
				}
			}
			if (cmd.name === "rm" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) {
					console.warn(`[RUMMY] Rejected file rm of ${cmd.path} in ask mode`);
					return null;
				}
			}
			if ((cmd.name === "mv" || cmd.name === "cp") && cmd.to) {
				const destScheme = KnownStore.scheme(cmd.to);
				if (destScheme === null) {
					console.warn(
						`[RUMMY] Rejected ${cmd.name} to file ${cmd.to} in ask mode`,
					);
					return null;
				}
			}
		}

		const scheme = cmd.name;

		// Structural tags — recorded like any other entry
		if (scheme === "summarize" || scheme === "update") {
			const statusPath = await this.#knownStore.slugPath(
				runId,
				scheme,
				cmd.body,
			);
			await this.#knownStore.upsert(runId, turn, statusPath, cmd.body, 200, {
				loopId,
			});
			return {
				scheme,
				body: cmd.body,
				path: statusPath,
				resultPath: statusPath,
				attributes: null,
			};
		}

		// Unknown — deduplicated, sticky
		if (scheme === "unknown") {
			const existingValues = await this.#knownStore.getUnknownValues(runId);
			if (existingValues.has(cmd.body)) {
				console.warn(`[RUMMY] Unknown deduped: "${cmd.body.slice(0, 60)}"`);
				return null;
			}
			const unknownPath = await this.#knownStore.slugPath(
				runId,
				"unknown",
				cmd.body,
			);
			await this.#knownStore.upsert(runId, turn, unknownPath, cmd.body, 200, {
				loopId,
			});
			return {
				scheme,
				path: unknownPath,
				body: cmd.body,
				resultPath: unknownPath,
				attributes: null,
			};
		}

		const rawTarget = cmd.path || cmd.command || cmd.question || "";
		const target = rawTarget;
		const resultPath = await this.#knownStore.dedup(runId, scheme, target);

		// Pass parsed command fields through as attributes
		const { name: _, ...attributes } = cmd;
		if (cmd.path) attributes.path = target;

		// known tool or naked write → known:// slug from body
		if (scheme === "known" || (scheme === "set" && !cmd.path)) {
			if (!cmd.body) return null;

			// Budget gate: reject if this entry would exceed context budget
			const entryTokens = countTokens(cmd.body);
			if (entryTokens > budgetRemaining) {
				const rejectPath = await this.#knownStore.slugPath(
					runId,
					scheme,
					cmd.body,
				);
				await this.#knownStore.upsert(
					runId,
					turn,
					rejectPath,
					`Context budget exceeded (${entryTokens} tokens, ${Math.max(0, budgetRemaining) | 0} remaining). Use <set fidelity="store"> to file entries, or <rm> old entries.`,
					413,
					{ loopId },
				);
				return {
					scheme,
					path: rejectPath,
					body: "",
					resultPath: rejectPath,
					attributes,
					status: 413,
				};
			}

			let knownPath = cmd.path;
			if (!knownPath) {
				knownPath = await this.#knownStore.slugPath(
					runId,
					"known",
					cmd.body,
				);
			}
			// Dedup: if this exact path already exists, update rather than duplicate
			const existing = await this.#knownStore.getEntriesByPattern(
				runId,
				knownPath,
				null,
			);
			if (existing.length > 0) {
				// Path exists — update body and turn, skip creating a new entry
				await this.#knownStore.upsert(runId, turn, existing[0].path, cmd.body || existing[0].body, 200, {
					loopId,
				});
				return {
					scheme: "known",
					path: existing[0].path,
					body: cmd.body || existing[0].body,
					resultPath: existing[0].path,
					attributes,
				};
			}
			await this.#knownStore.upsert(runId, turn, knownPath, cmd.body, 200, {
				loopId,
			});
			return {
				scheme: "known",
				path: knownPath,
				body: cmd.body,
				resultPath: knownPath,
				attributes,
			};
		}

		// Budget gate: reject if this entry would exceed context budget
		const body = cmd.body || cmd.command || cmd.question || "";
		const entryTokens = countTokens(body);
		if (body && entryTokens > budgetRemaining) {
			await this.#knownStore.upsert(
				runId,
				turn,
				resultPath,
				`Context budget exceeded (${entryTokens} tokens, ${Math.max(0, budgetRemaining) | 0} remaining). Use <set fidelity="store"> to file entries, or <rm> old entries.`,
				413,
				{ attributes, loopId },
			);
			return {
				scheme,
				path: resultPath,
				body: "",
				attributes,
				status: 413,
				resultPath,
			};
		}

		// Record the entry — 200 OK, handlers change status during dispatch
		await this.#knownStore.upsert(runId, turn, resultPath, body, 200, {
			attributes,
			loopId,
		});

		return {
			scheme,
			path: resultPath,
			body,
			attributes,
			status: 200,
			resultPath,
		};
	}

	async #rematerialize(runId, loopId, turn) {
		await this.#db.clear_turn_context.run({ run_id: runId, turn });
		const viewRows = await this.#db.get_model_context.all({ run_id: runId });
		for (const row of viewRows) {
			const scheme = row.scheme || "file";
			const projectedBody = await this.#hooks.tools.view(scheme, {
				path: row.path,
				scheme,
				body: row.body,
				attributes: row.attributes ? JSON.parse(row.attributes) : null,
				fidelity: row.fidelity,
				category: row.category,
			});
			await this.#db.insert_turn_context.run({
				run_id: runId,
				loop_id: loopId,
				turn,
				ordinal: row.ordinal,
				path: row.path,
				fidelity: row.fidelity,
				status: row.status,
				body: projectedBody ?? "",
				tokens: countTokens(projectedBody ?? ""),
				attributes: row.attributes,
				category: row.category,
				source_turn: row.turn,
			});
		}
	}
}
