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

		// --- BUDGET CASCADE ---
		// Materialize → render → measure → demote batch → repeat.
		// Four tiers: full→summary, summary→index, index→stash, hard error.
		// Always re-render and re-measure. Never trust estimated savings.

		let rows = await this.#db.get_turn_context.all({
			run_id: currentRunId,
			turn,
		});
		const assembleOpts = () => ({
			type: mode,
			systemPrompt,
			contextSize,
			demoted,
		});
		let messages = await ContextAssembler.assembleFromTurnContext(
			rows,
			assembleOpts(),
			this.#hooks,
		);

		if (contextSize) {
			const ceiling = contextSize * 0.95;
			const measure = (msgs) =>
				msgs.reduce((sum, m) => sum + countTokens(m.content || ""), 0);

			// Demotion priority: files/results first, then knowns, then unknowns.
			// Within each tier, oldest first. Model memory demoted last.
			const DEMOTION_ORDER = {
				prompt: 0,
				result: 0,
				structural: 0,
				file: 1,
				file_index: 1,
				file_summary: 1,
				known: 2,
				known_index: 2,
				unknown: 3,
			};
			const sortCandidates = (list) =>
				list.toSorted((a, b) => {
					const tierA = DEMOTION_ORDER[a.category] ?? 99;
					const tierB = DEMOTION_ORDER[b.category] ?? 99;
					if (tierA !== tierB) return tierA - tierB;
					return a.source_turn - b.source_turn;
				});

			const remeasure = async () => {
				await this.#rematerialize(currentRunId, currentLoopId, turn);
				rows = await this.#db.get_turn_context.all({
					run_id: currentRunId,
					turn,
				});
				messages = await ContextAssembler.assembleFromTurnContext(
					rows,
					assembleOpts(),
					this.#hooks,
				);
				return measure(messages);
			};

			let assembledTokens = measure(messages);

			// Tier 1: Full → summary
			if (assembledTokens > ceiling) {
				const candidates = sortCandidates(
					rows.filter(
						(r) =>
							r.fidelity === "full" &&
							r.tokens > 0 &&
							DEMOTION_ORDER[r.category] !== undefined,
					),
				);
				const target = (assembledTokens - ceiling) * 1.1;
				let accumulated = 0;
				for (const entry of candidates) {
					if (accumulated >= target) break;
					await this.#knownStore.setFidelity(currentRunId, entry.path, "summary");
					accumulated += entry.tokens;
					demoted.push(entry.path);
				}
				if (demoted.length > 0) {
					assembledTokens = await remeasure();
					console.warn(
						`[RUMMY] Budget tier 1: ${demoted.length} full→summary (${assembledTokens}/${contextSize} tokens)`,
					);
				}
			}

			// Tier 2: Summary → index (path only)
			if (assembledTokens > ceiling) {
				const candidates = sortCandidates(
					rows.filter(
						(r) =>
							r.fidelity === "summary" &&
							r.tokens > 0 &&
							DEMOTION_ORDER[r.category] !== undefined,
					),
				);
				const target = (assembledTokens - ceiling) * 1.1;
				let accumulated = 0;
				const tier2 = [];
				for (const entry of candidates) {
					if (accumulated >= target) break;
					await this.#knownStore.setFidelity(currentRunId, entry.path, "index");
					accumulated += entry.tokens;
					tier2.push(entry.path);
					demoted.push(entry.path);
				}
				if (tier2.length > 0) {
					assembledTokens = await remeasure();
					console.warn(
						`[RUMMY] Budget tier 2: ${tier2.length} summary→index (${assembledTokens}/${contextSize} tokens)`,
					);
				}
			}

			// Tier 3: Index → stored (invisible) — collapse to stash entries
			if (assembledTokens > ceiling) {
				const candidates = sortCandidates(
					rows.filter(
						(r) =>
							r.fidelity === "index" &&
							DEMOTION_ORDER[r.category] !== undefined,
					),
				);
				const tier3 = [];
				for (const entry of candidates) {
					await this.#knownStore.setFidelity(currentRunId, entry.path, "stored");
					tier3.push(entry.path);
					demoted.push(entry.path);
				}
				if (tier3.length > 0) {
					// Create stash entries — one per scheme with stored content
					await this.#stashStoredEntries(currentRunId, turn, currentLoopId);
					assembledTokens = await remeasure();
					console.warn(
						`[RUMMY] Budget tier 3: ${tier3.length} index→stashed (${assembledTokens}/${contextSize} tokens)`,
					);
				}
			}

			// Tier 4: Hard error — floor doesn't fit
			if (assembledTokens > ceiling) {
				throw new Error(
					`Context floor (${assembledTokens} tokens) exceeds model limit (${contextSize}). ` +
						"Reduce system prompt size or use a model with a larger context window.",
				);
			}
		}

		let filteredMessages = await this.#hooks.llm.messages.filter(messages, {
			model: requestedModel,
			projectId,
			runId: currentRunId,
		});

		// Call LLM
		await this.#hooks.llm.request.started.emit({ model: requestedModel, turn });
		const rawResult = await this.#llmProvider.completion(
			filteredMessages,
			requestedModel,
			{ temperature: options?.temperature, signal },
		);
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
		// Every command becomes an entry. No execution yet.

		const recorded = [];
		let summaryText = null;
		let updateText = null;

		// Track budget headroom for 413 rejection during recording
		const budgetCeiling = contextSize ? contextSize * 0.95 : null;
		const currentBudgetUsed = budgetCeiling
			? (await this.#db.get_turn_budget.get({ run_id: currentRunId, turn }))
					?.total ?? 0
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

			if (entry.scheme === "summarize") summaryText = entry.body;
			else if (entry.scheme === "update") updateText = entry.body;
			else recorded.push(entry);

			// Deduct from remaining budget
			if (entry.body && budgetCeiling) {
				budgetRemaining -= countTokens(entry.body);
			}
		}

		// If model sent both, summary wins
		if (summaryText && updateText) updateText = null;

		// If model sent neither, heal from content
		let statusHealed = false;
		if (!summaryText && !updateText) {
			const healed = ResponseHealer.healStatus(content, commands);
			summaryText = healed.summaryText;
			updateText = healed.updateText;
			statusHealed = true;
		}

		// Record healed status
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
				200,
				{ loopId: currentLoopId },
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
				200,
				{ loopId: currentLoopId },
			);
		}

		// --- PHASE 2: DISPATCH ---
		// Sequential execution. Stop on proposal or error — abort the rest.

		let hasErrors = false;
		let hasProposed = false;
		let abortAfter = null;
		const dispatched = [];

		for (const entry of recorded) {
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

		// Materialize proposals only if we dispatched without early abort
		if (!abortAfter || hasProposed) {
			await this.#hooks.turn.proposing.emit({ rummy, recorded: dispatched });
		}

		// Recheck after materialization (set handler may create proposals)
		if (!hasProposed && !hasErrors) {
			for (const entry of dispatched) {
				const row = await this.#db.get_entry_state.get({
					run_id: currentRunId,
					path: entry.resultPath || entry.path,
				});
				if (row?.status === 202) hasProposed = true;
				if (row?.status >= 400) hasErrors = true;
			}
		}

		// Errors override summarize — the model thinks it's done but it's not
		if (hasErrors && summaryText) {
			summaryText = null;
			updateText = "Tool errors detected — retry or investigate.";
		}

		// Proposals override summarize — outcome unknown until user resolves
		if (hasProposed && summaryText) {
			summaryText = null;
			updateText = "Awaiting approval for proposed changes.";
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

		// Structural tags — record and return (no handler dispatch)
		if (scheme === "summarize" || scheme === "update") {
			return { scheme, body: cmd.body, resultPath: null, attributes: null };
		}

		// Unknown — deduplicated, sticky
		if (scheme === "unknown") {
			const existingValues = await this.#knownStore.getUnknownValues(runId);
			if (existingValues.has(cmd.body)) return null;
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
				const rejectPath = await this.#knownStore.slugPath(runId, scheme, cmd.body);
				await this.#knownStore.upsert(
					runId, turn, rejectPath,
					`Context budget exceeded (${entryTokens} tokens, ${Math.max(0, budgetRemaining) | 0} remaining). Use <set fidelity="store"> to file entries, or <rm> old entries.`,
					413, { loopId },
				);
				return { scheme, path: rejectPath, body: "", resultPath: rejectPath, attributes, status: 413 };
			}

			let knownPath = cmd.path;
			if (!knownPath) {
				// Dedup: if an existing known entry shares the same first 80 chars, reuse it
				const prefix = cmd.body.slice(0, 80);
				const existing = await this.#knownStore.getEntriesByPattern(
					runId,
					"known://*",
					prefix,
				);
				knownPath =
					existing[0]?.path ||
					(await this.#knownStore.slugPath(runId, "known", cmd.body));
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
				runId, turn, resultPath,
				`Context budget exceeded (${entryTokens} tokens, ${Math.max(0, budgetRemaining) | 0} remaining). Use <set fidelity="store"> to file entries, or <rm> old entries.`,
				413, { attributes, loopId },
			);
			return { scheme, path: resultPath, body: "", attributes, status: 413, resultPath };
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

	/**
	 * Collapse all stored entries into per-scheme stash entries.
	 * A stash entry is a known:// entry containing a comma-separated
	 * list of paths for entries that were demoted to stored fidelity.
	 * Gives the model awareness of what's in the filing cabinet.
	 */
	async #stashStoredEntries(runId, turn, loopId) {
		const entries = await this.#db.get_known_entries.all({ run_id: runId });
		const stored = entries.filter((e) => e.fidelity === "stored" && e.status === 200);

		const byScheme = {};
		for (const entry of stored) {
			const scheme = entry.scheme || "file";
			byScheme[scheme] ??= [];
			byScheme[scheme].push(entry.path);
		}

		for (const [scheme, paths] of Object.entries(byScheme)) {
			const stashPath = `known://stash_${scheme}`;
			const body = paths.join(", ");
			await this.#knownStore.upsert(runId, turn, stashPath, body, 200, {
				loopId,
			});
		}
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
