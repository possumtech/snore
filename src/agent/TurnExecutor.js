import RummyContext from "../hooks/RummyContext.js";
import ContextAssembler from "./ContextAssembler.js";
import ResponseHealer from "./ResponseHealer.js";
import { countTokens } from "./tokens.js";
import XmlParser from "./XmlParser.js";

const ACTION_SCHEMES = new Set([
	"get",
	"set",
	"rm",
	"mv",
	"cp",
	"sh",
	"env",
	"search",
]);
const MUTATION_SCHEMES = new Set(["set", "rm", "sh", "mv", "cp"]);
const READ_SCHEMES = new Set(["get", "env", "search"]);

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

	/**
	 * Rebuild turn_context from v_model_context, then assemble messages.
	 * Called at turn start and again after any fidelity demotion within the turn.
	 */
	async #materializeTurnContext({
		runId,
		loopId,
		turn,
		systemPrompt,
		mode,
		toolSet,
		contextSize,
		demoted,
	}) {
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
				// Full-body token count, not projected. This is the cost to
				// promote the entry — the number the model needs to do Token
				// Budget math. Projecting the demoted symbol-preview (145
				// tokens for a 2108-token file) was misleading the model into
				// promotes that blew the Token Budget by 10-30× per entry.
				tokens: countTokens(row.body ?? ""),
				attributes: row.attributes,
				category: row.category,
				source_turn: row.turn,
			});
		}
		const rows = await this.#db.get_turn_context.all({ run_id: runId, turn });
		const lastCtx = await this.#db.get_last_context_tokens.get({
			run_id: runId,
		});
		const lastContextTokens = lastCtx?.context_tokens ?? 0;

		// Baseline materialization — assemble with model's promoted spending
		// removed (promoted data, promoted logging). The resulting size is the
		// fixed overhead the model can't reduce without further demotion.
		const baselineRows = rows.filter(
			(r) =>
				!(
					(r.category === "data" || r.category === "logging") &&
					r.fidelity === "promoted"
				),
		);
		const baselineMessages = await ContextAssembler.assembleFromTurnContext(
			baselineRows,
			{
				type: mode,
				systemPrompt,
				contextSize,
				demoted,
				toolSet,
				lastContextTokens,
				turn,
			},
			this.#hooks,
		);
		const baselineTokens = baselineMessages.reduce(
			(sum, m) => sum + countTokens(m.content),
			0,
		);

		const messages = await ContextAssembler.assembleFromTurnContext(
			rows,
			{
				type: mode,
				systemPrompt,
				contextSize,
				demoted,
				toolSet,
				lastContextTokens,
				turn,
				baselineTokens,
			},
			this.#hooks,
		);
		return { rows, messages, lastContextTokens };
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
		loopIteration,
		noRepo,
		toolSet,
		inRecovery = false,
		contextSize,
		options,
		signal,
	}) {
		const RECOVERY_EXCLUDED = new Set([
			"sh",
			"env",
			"search",
			"ask_user",
			"set",
		]);
		const effectiveToolSet = inRecovery
			? new Set([...toolSet].filter((t) => !RECOVERY_EXCLUDED.has(t)))
			: toolSet;

		const turn = await this.#knownStore.nextTurn(currentRunId);

		const turnRow = await this.#db.create_turn.get({
			run_id: currentRunId,
			loop_id: currentLoopId,
			sequence: turn,
		});

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
				noRepo,
				toolSet: effectiveToolSet,
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
			loopIteration,
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
			fidelity: "promoted",
			category: "system",
		});

		// Materialize turn_context: VIEW rows projected through tools
		const demoted = [];
		let { rows, messages, lastContextTokens } =
			await this.#materializeTurnContext({
				runId: currentRunId,
				loopId: currentLoopId,
				turn,
				systemPrompt,
				mode,
				toolSet: effectiveToolSet,
				contextSize,
				demoted,
			});

		await this.#hooks.context.materialized.emit({
			runId: currentRunId,
			turn,
			rowCount: rows.length,
		});

		await this.#hooks.run.progress.emit({
			projectId,
			run: currentAlias,
			turn,
			status: "thinking",
		});

		const budgetResult = await this.#hooks.budget.enforce({
			contextSize,
			messages,
			rows,
			lastPromptTokens: lastContextTokens,
		});
		messages = budgetResult.messages;
		rows = budgetResult.rows;
		let assembledTokens =
			budgetResult.assembledTokens ??
			messages.reduce((sum, m) => sum + countTokens(m.content), 0);

		if (budgetResult.status === 413) {
			if (loopIteration === 1) {
				// Prompt Demotion: first-turn overflow — demote incoming prompt to summary
				const promptRow = rows.findLast(
					(r) => r.category === "prompt" && r.scheme === "prompt",
				);
				if (promptRow) {
					await this.#knownStore.setFidelity(
						currentRunId,
						promptRow.path,
						"demoted",
					);
				}
				const reMat = await this.#materializeTurnContext({
					runId: currentRunId,
					loopId: currentLoopId,
					turn,
					systemPrompt,
					mode,
					toolSet: effectiveToolSet,
					contextSize,
					demoted,
				});
				rows = reMat.rows;
				messages = reMat.messages;
				const recheck = await this.#hooks.budget.enforce({
					contextSize,
					messages,
					rows,
					lastPromptTokens: reMat.lastContextTokens,
				});
				messages = recheck.messages;
				rows = recheck.rows;
				assembledTokens =
					recheck.assembledTokens ??
					messages.reduce((sum, m) => sum + countTokens(m.content), 0);
				if (recheck.status === 413) {
					return {
						turn,
						turnId: turnRow.id,
						status: 413,
						assembledTokens,
						contextSize,
						overflow: recheck.overflow,
					};
				}
			} else {
				// Base context too large even without new prompt — genuine failure
				return {
					turn,
					turnId: turnRow.id,
					status: 413,
					assembledTokens,
					contextSize,
					overflow: budgetResult.overflow,
				};
			}
		}

		const runRow = await this.#db.get_run_by_id.get({ id: currentRunId });
		const filteredMessages = await this.#hooks.llm.messages.filter(messages, {
			model: requestedModel,
			projectId,
			runId: currentRunId,
			runAlias: runRow?.alias || `run_${currentRunId}`,
			turn,
		});

		// Call LLM
		await this.#hooks.llm.request.started.emit({ model: requestedModel, turn });
		let rawResult;
		const isTransient = (e) =>
			/\b(503|429|timeout|ECONNREFUSED|ECONNRESET|unavailable)\b/i.test(
				e.message,
			);
		const isContextExceeded = (e) =>
			/\b(context.*(size|length|limit)|token.*(limit|exceed)|too.*(long|large))\b/i.test(
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
				if (isContextExceeded(err)) {
					console.warn(
						`[RUMMY] LLM context exceeded: ${err.message.slice(0, 120)}. Returning 413.`,
					);
					return {
						turn,
						turnId: turnRow.id,
						status: 413,
						assembledTokens,
						contextSize,
					};
				}
				throw err;
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

		// Ensure reasoning_content captures both API field and <think> tag
		if (responseMessage) {
			const thinkCmds = commands.filter((c) => c.name === "think");
			const thinkText = thinkCmds
				.map((c) => c.body)
				.filter(Boolean)
				.join("\n");
			const apiReasoning = responseMessage.reasoning_content || "";
			const parts = [apiReasoning, thinkText].filter(Boolean);
			responseMessage.reasoning_content =
				parts.length > 0 ? parts.join("\n") : null;
		}

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
			assembledTokens,
			contextSize,
			systemMsg: systemMsg?.content,
			userMsg: userMsg?.content,
		});

		// --- PHASE 1: RECORD ---
		const recorded = [];
		for (const cmd of commands) {
			const entry = await this.#record(
				currentRunId,
				currentLoopId,
				turn,
				mode,
				cmd,
			);
			if (entry) recorded.push(entry);
		}

		// --- PHASE 2: DISPATCH ---
		// Sequential queue. Each tool completes before the next starts.
		// On failure: abort remaining. On proposal: notify client, await
		// resolution, continue.
		let hasErrors = false;
		let abortAfter = null;

		for (const entry of recorded) {
			if (entry.status >= 400) continue;

			if (abortAfter) {
				const errorMsg = `Aborted — preceding <${abortAfter}> failed.`;
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					entry.resultPath || entry.path,
					errorMsg,
					409,
					{ attributes: { error: errorMsg }, loopId: currentLoopId },
				);
				hasErrors = true;
				continue;
			}

			await this.#hooks.tool.before.emit({ entry, rummy });
			try {
				await this.#hooks.tools.dispatch(entry.scheme, entry, rummy);
			} catch (dispatchErr) {
				console.error(
					`[RUMMY] Dispatch crash <${entry.scheme}>: ${dispatchErr.message}`,
				);
				await this.#knownStore.upsert(
					currentRunId,
					turn,
					entry.resultPath || entry.path,
					dispatchErr.message,
					500,
					{ loopId: currentLoopId },
				);
				hasErrors = true;
				abortAfter = entry.scheme;
				continue;
			}
			await this.#hooks.tool.after.emit({ entry, rummy });
			await this.#hooks.entry.created.emit(entry);

			// Push incremental state so the client waterfall builds live.
			const history = await this.#knownStore.getLog(currentRunId);
			const unknowns = await this.#db.get_unknowns.all({
				run_id: currentRunId,
			});
			await this.#hooks.run.state.emit({
				projectId,
				run: currentAlias,
				turn,
				status: 102,
				summary: "",
				history,
				unknowns: unknowns.map((u) => ({ path: u.path, body: u.body })),
				telemetry: null,
			});

			// Materialize proposals for this entry (set revisions → 202)
			await this.#hooks.turn.proposing.emit({ rummy, recorded: [entry] });

			// Check for any proposals created by this entry's dispatch
			const proposed = await this.#knownStore.getUnresolved(currentRunId);
			for (const p of proposed) {
				await this.#hooks.turn.proposal.emit({
					projectId,
					run: currentAlias,
					proposed: [p],
				});
				await this.#knownStore.waitForResolution(currentRunId, p.path);
				const resolved = await this.#db.get_entry_state.get({
					run_id: currentRunId,
					path: p.path,
				});
				if (resolved?.status >= 400) {
					hasErrors = true;
					abortAfter = entry.scheme;
				}
			}

			// Also check the entry itself for direct failures
			if (!hasErrors) {
				const entryPath = entry.resultPath || entry.path;
				const row = await this.#db.get_entry_state.get({
					run_id: currentRunId,
					path: entryPath,
				});
				if (row?.status >= 400) {
					hasErrors = true;
					abortAfter = entry.scheme;
				}
			}
		}

		// Turn Demotion: if end-of-turn context exceeds ceiling, demote this
		// turn's data entries and the incoming prompt to summary, then force a
		// budget recovery phase before continuing.
		let budgetRecovery = null;
		// Use actual prompt_tokens from this turn's LLM response as the ground-truth
		// Post-dispatch budget check — demotion handled by budget plugin
		if (contextSize) {
			const postMat = await this.#materializeTurnContext({
				runId: currentRunId,
				loopId: currentLoopId,
				turn,
				systemPrompt,
				mode,
				toolSet: effectiveToolSet,
				contextSize,
				demoted,
			});
			budgetRecovery = await this.#hooks.budget.postDispatch({
				contextSize,
				messages: postMat.messages,
				rows: postMat.rows,
				runId: currentRunId,
				loopId: currentLoopId,
				turn,
				db: this.#db,
				store: this.#knownStore,
			});
		}

		const updateEntry = recorded.findLast((e) => e.scheme === "update");
		const updateStatus = updateEntry?.attributes?.status ?? 102;
		let summaryText = updateStatus === 200 ? updateEntry?.body || null : null;
		let updateText = updateStatus !== 200 ? updateEntry?.body || null : null;

		// If model says "done" (status=200) but actions failed, override
		if (summaryText && hasErrors) {
			console.warn(
				'[RUMMY] Overriding <update status="200"> — actions in this turn failed. Continuing.',
			);
			if (updateEntry?.path) {
				await this.#knownStore.resolve(
					currentRunId,
					updateEntry.path,
					409,
					"Overridden — actions in this turn failed. Continue with <update/>.",
				);
			}
			updateText = summaryText;
			summaryText = null;
		}

		// If model sent no update, heal from content
		let statusHealed = false;
		if (!summaryText && !updateText) {
			const healed = ResponseHealer.healStatus(content, commands);
			summaryText = healed.summaryText;
			updateText = healed.updateText;
			statusHealed = true;
		}

		// --- Classify for return value ---

		const actionCalls = recorded.filter((e) => ACTION_SCHEMES.has(e.scheme));
		const writeCalls = recorded.filter(
			(e) =>
				e.scheme === "known" ||
				(e.scheme === "set" && !e.attributes?.blocks && !e.attributes?.search),
		);
		const unknownCalls = recorded.filter((e) => e.scheme === "unknown");

		const hasAct = actionCalls.some((c) => MUTATION_SCHEMES.has(c.scheme));
		const hasReads = actionCalls.some((c) => READ_SCHEMES.has(c.scheme));
		const hasWrites = writeCalls.length > 0 || unknownCalls.length > 0;
		const flags = { hasAct, hasReads, hasWrites };

		const askUserEntry = recorded.find((e) => e.scheme === "ask_user");

		const turnResult = {
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
			temperature: options?.temperature,
			contextSize,
			assembledTokens,
			usage: result.usage,
			budgetRecovery,
		};

		await this.#hooks.turn.completed.emit(turnResult);

		return turnResult;
	}

	/**
	 * Record a parsed command as a known_entries row.
	 * Returns the recorded entry descriptor, or null if rejected/skipped.
	 */
	async #record(runId, loopId, turn, mode, cmd) {
		const scheme = cmd.name;
		const rawTarget = cmd.path || cmd.command || cmd.question || "";
		// Reject paths that are likely reasoning bleed — too long or contain non-printing chars
		if (rawTarget.length > 512 || /\p{Cc}/u.test(rawTarget)) {
			const rejectPath = await this.#knownStore.dedup(
				runId,
				scheme,
				`${scheme}://invalid`,
				turn,
			);
			await this.#knownStore.upsert(
				runId,
				turn,
				rejectPath,
				`Invalid path: too long or contains non-printing characters`,
				400,
				{ loopId },
			);
			return {
				scheme,
				path: rejectPath,
				body: "",
				attributes: {},
				status: 400,
				resultPath: rejectPath,
			};
		}
		const target = rawTarget;
		const resultPath = await this.#knownStore.dedup(
			runId,
			scheme,
			target,
			turn,
		);

		// Pass parsed command fields through as attributes
		const { name: _, ...attributes } = cmd;
		if (cmd.path) attributes.path = target;

		const body = cmd.body || cmd.command || cmd.question || "";

		// Filter: plugins can validate/transform before recording
		const filtered = await this.#hooks.entry.recording.filter(
			{ scheme, path: resultPath, body, attributes, status: 200 },
			{ runId, turn, loopId, mode },
		);
		if (filtered.status >= 400) return filtered;

		return {
			scheme: filtered.scheme,
			path: filtered.path,
			body: filtered.body,
			attributes: filtered.attributes,
			status: 200,
			resultPath: filtered.path,
		};
	}
}
