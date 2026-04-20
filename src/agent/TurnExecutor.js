import RummyContext from "../hooks/RummyContext.js";
import { ContextExceededError } from "../llm/errors.js";
import materializeContext from "./materializeContext.js";
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
		loopIteration,
		noRepo,
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
				toolSet,
				contextSize,
				systemPrompt: null,
				loopPrompt,
			},
		);
		// Plugins write prompt/instructions entries
		await this.#hooks.turn.started.emit({
			rummy,
			mode,
			prompt: loopPrompt,
			isContinuation: options?.isContinuation,
			loopIteration,
		});

		await this.#hooks.processTurn(rummy);

		// Project instructions://system through the instructions tool's projection
		const systemPrompt =
			await this.#hooks.instructions.resolveSystemPrompt(rummy);

		// Materialize turn_context: VIEW rows projected through tools
		const demoted = [];
		const budgetCtx = {
			runId: currentRunId,
			loopId: currentLoopId,
			turn,
			systemPrompt,
			mode,
			toolSet,
			demoted,
			loopIteration,
		};
		const initial = await materializeContext({
			db: this.#db,
			hooks: this.#hooks,
			contextSize,
			...budgetCtx,
		});

		await this.#hooks.context.materialized.emit({
			runId: currentRunId,
			turn,
			rowCount: initial.rows.length,
		});

		const budgetResult = await this.#hooks.budget.enforce({
			contextSize,
			messages: initial.messages,
			rows: initial.rows,
			lastPromptTokens: initial.lastContextTokens,
			ctx: budgetCtx,
			rummy,
		});
		const messages = budgetResult.messages;
		const assembledTokens = budgetResult.assembledTokens;

		if (!budgetResult.ok) {
			return {
				turn,
				turnId: turnRow.id,
				state: "failed",
				outcome: `overflow:${budgetResult.overflow}`,
				assembledTokens,
				contextSize,
				overflow: budgetResult.overflow,
			};
		}

		const runRow = await this.#db.get_run_by_id.get({ id: currentRunId });
		const filteredMessages = await this.#hooks.llm.messages.filter(messages, {
			model: requestedModel,
			projectId,
			runId: currentRunId,
			runAlias: runRow?.alias || `run_${currentRunId}`,
			turn,
		});

		// Call LLM. Transient-error retry + context-exceeded detection live
		// in LlmProvider; context-exceeded surfaces as ContextExceededError.
		await this.#hooks.llm.request.started.emit({ model: requestedModel, turn });
		let rawResult;
		try {
			rawResult = await this.#llmProvider.completion(
				filteredMessages,
				requestedModel,
				{ temperature: options?.temperature, signal },
			);
		} catch (err) {
			if (err instanceof ContextExceededError) {
				return {
					turn,
					turnId: turnRow.id,
					state: "failed",
					outcome: "overflow:llm",
					assembledTokens,
					contextSize,
				};
			}
			throw err;
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

		// Parse and emit — plugins handle audit storage
		const { commands, warnings, unparsed } = XmlParser.parse(content);
		for (const w of warnings) {
			await this.#hooks.error.log.emit({
				store: this.#knownStore,
				runId: currentRunId,
				turn,
				message: w,
				loopId: currentLoopId,
			});
		}

		// Merge reasoning contributions from subscribers (think plugin's
		// <think> tag, other plugin reasoning sources). Filter starts with
		// the API-provided reasoning_content and layers on each plugin's
		// contribution.
		if (responseMessage) {
			responseMessage.reasoning_content =
				(await this.#hooks.llm.reasoning.filter(
					responseMessage.reasoning_content || "",
					{ commands },
				)) || null;
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
		let hasErrors = unparsed?.trim() ? true : false;
		let abortAfter = null;

		for (const entry of recorded) {
			if (entry.state === "failed" || entry.state === "cancelled") continue;

			if (abortAfter) {
				const errorMsg = `Aborted — preceding <${abortAfter}> failed.`;
				await this.#knownStore.set({
					runId: currentRunId,
					turn,
					path: entry.resultPath || entry.path,
					body: errorMsg,
					state: "failed",
					outcome: "aborted",
					attributes: { error: errorMsg },
					loopId: currentLoopId,
				});
				hasErrors = true;
				continue;
			}

			await this.#hooks.tool.before.emit({ entry, rummy });
			try {
				await this.#hooks.tools.dispatch(entry.scheme, entry, rummy);
			} catch (dispatchErr) {
				await this.#hooks.error.log.emit({
					store: this.#knownStore,
					runId: currentRunId,
					turn,
					loopId: currentLoopId,
					message: `Dispatch crash in ${entry.scheme}: ${dispatchErr.message}`,
				});
				hasErrors = true;
				abortAfter = entry.scheme;
				continue;
			}
			await this.#hooks.tool.after.emit({ entry, rummy });
			await this.#hooks.entry.created.emit(entry);

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
				const resolved = await this.#knownStore.getState(currentRunId, p.path);
				if (resolved?.status >= 400) {
					hasErrors = true;
					abortAfter = entry.scheme;
				}
			}

			// Also check the entry itself for direct failures
			if (!hasErrors) {
				const entryPath = entry.resultPath || entry.path;
				const row = await this.#knownStore.getState(currentRunId, entryPath);
				if (row?.status >= 400) {
					hasErrors = true;
					abortAfter = entry.scheme;
				}
			}
		}

		// Turn Demotion: budget plugin re-materializes end-of-turn context,
		// demotes this turn's promoted entries on overflow, writes budget://.
		await this.#hooks.budget.postDispatch({
			contextSize,
			ctx: budgetCtx,
			rummy,
		});

		const { summaryText, updateText, strike } =
			await this.#hooks.update.resolve({
				recorded,
				hasErrors,
				content,
				commands,
				runId: currentRunId,
				turn,
				loopId: currentLoopId,
				rummy,
			});

		const askUserEntry = recorded.find((e) => e.scheme === "ask_user");

		const turnResult = {
			turn,
			turnId: turnRow.id,
			recorded,
			summaryText,
			updateText,
			strike,
			hasErrors,
			askUserCmd: askUserEntry || null,
			model: result.model || requestedModel,
			modelAlias: requestedModel,
			temperature: options?.temperature,
			contextSize,
			assembledTokens,
			usage: result.usage,
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
			await this.#knownStore.set({
				runId,
				turn,
				path: rejectPath,
				body: `Invalid path: too long or contains non-printing characters`,
				state: "failed",
				outcome: "validation",
				loopId,
			});
			return {
				scheme,
				path: rejectPath,
				body: "",
				attributes: {},
				state: "failed",
				outcome: "validation",
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
			{
				scheme,
				path: resultPath,
				body,
				attributes,
				state: "resolved",
				outcome: null,
			},
			{ store: this.#knownStore, runId, turn, loopId, mode },
		);
		if (filtered.state === "failed" || filtered.state === "cancelled") {
			return filtered;
		}

		return {
			scheme: filtered.scheme,
			path: filtered.path,
			body: filtered.body,
			attributes: filtered.attributes,
			state: "resolved",
			resultPath: filtered.path,
		};
	}
}
