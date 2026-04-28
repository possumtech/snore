import msg from "./messages.js";

const HTTP_TO_RUN_STATE = {
	100: "proposed",
	102: "streaming",
	200: "resolved",
	202: "streaming",
	499: "cancelled",
	500: "failed",
};

export default class AgentLoop {
	#db;
	#llmProvider;
	#hooks;
	#turnExecutor;
	#entries;
	#activeRuns = new Map();

	constructor(db, llmProvider, hooks, turnExecutor, entries) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#turnExecutor = turnExecutor;
		this.#entries = entries;
	}

	abort(runId) {
		const active = this.#activeRuns.get(runId);
		if (active) active.controller.abort();
	}

	// Abort all in-flight runs and drain; rejections were already surfaced to original awaiters.
	async abortAll() {
		const promises = [];
		for (const { controller, promise } of this.#activeRuns.values()) {
			controller.abort();
			promises.push(promise);
		}
		await Promise.allSettled(promises);
	}

	async #generateAlias(modelAlias) {
		return `${modelAlias}_${Date.now()}`;
	}

	#buildContinuationPrompt(turn, maxTurns) {
		return `Turn ${turn}/${maxTurns}`;
	}

	async #setRunStatus(runId, alias, httpStatus) {
		await this.#db.update_run_status.run({ id: runId, status: httpStatus });
		const state = HTTP_TO_RUN_STATE[httpStatus];
		if (!state) return;
		await this.#entries.set({
			runId,
			path: `run://${alias}`,
			state,
			writer: "system",
		});
	}

	async #writeRunEntry(
		runId,
		alias,
		prompt,
		{
			projectId,
			parentRunId,
			model,
			persona = null,
			temperature = null,
			contextLimit = null,
		},
	) {
		await this.#entries.set({
			runId,
			turn: 0,
			path: `run://${alias}`,
			body: prompt ? prompt : "",
			state: "proposed",
			attributes: {
				projectId,
				parentRunId,
				model,
				persona,
				temperature,
				contextLimit,
			},
			writer: "system",
		});
	}

	async ensureRun(projectId, model, run, prompt, options = {}) {
		const {
			fork: isFork = false,
			temperature = null,
			persona = null,
			contextLimit = null,
		} = options;
		const requestedModel = model;

		if (run && isFork) {
			const existingRun = await this.#db.get_run_by_alias.get({ alias: run });
			if (!existingRun)
				throw new Error(msg("error.run_not_found", { runId: run }));
			const alias = await this.#generateAlias(requestedModel);
			const runRow = await this.#db.create_run.get({
				project_id: projectId,
				parent_run_id: existingRun.id,
				model: requestedModel,
				alias,
				temperature,
				persona,
				context_limit: contextLimit,
			});
			await this.#entries.forkEntries(existingRun.id, runRow.id);
			await this.#writeRunEntry(runRow.id, alias, prompt, {
				projectId,
				parentRunId: existingRun.id,
				model: requestedModel,
				persona,
				temperature,
				contextLimit,
			});
			await this.#hooks.run.created.emit({
				runId: runRow.id,
				alias,
				forkedFrom: existingRun.id,
			});
			return { runId: runRow.id, alias };
		}

		if (run) {
			const existingRun = await this.#db.get_run_by_alias.get({ alias: run });
			if (existingRun) {
				const existing = this.#activeRuns.get(existingRun.id);
				if (existing) existing.controller.abort();

				const unresolved = await this.#entries.getUnresolved(existingRun.id);
				for (const u of unresolved) {
					await this.#entries.set({
						runId: existingRun.id,
						path: u.path,
						state: "cancelled",
						body: "Stale proposal from interrupted run",
						outcome: "interrupted",
					});
				}
				return { runId: existingRun.id, alias: existingRun.alias };
			}
		}

		const alias = run ? run : await this.#generateAlias(requestedModel);
		const runRow = await this.#db.create_run.get({
			project_id: projectId,
			parent_run_id: null,
			model: requestedModel,
			alias,
			temperature,
			persona,
			context_limit: contextLimit,
		});
		await this.#writeRunEntry(runRow.id, alias, prompt, {
			projectId,
			parentRunId: null,
			model: requestedModel,
			persona,
			temperature,
			contextLimit,
		});
		await this.#hooks.run.created.emit({ runId: runRow.id, alias });
		return { runId: runRow.id, alias };
	}

	async run(
		mode,
		projectId,
		model,
		prompt,
		projectBufferFiles = null,
		run = null,
		options = {},
	) {
		const hook = mode === "ask" ? this.#hooks.ask : this.#hooks.act;
		await hook.started.emit({
			projectId,
			model,
			prompt,
			projectBufferFiles,
			run,
		});

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		if (!project)
			throw new Error(msg("error.project_not_found", { projectId }));

		const noRepo = options?.noRepo ?? process.env.RUMMY_NO_REPO === "1";
		const noInteraction =
			options?.noInteraction ?? process.env.RUMMY_NO_INTERACTION === "1";
		const noWeb = options?.noWeb ?? process.env.RUMMY_NO_WEB === "1";
		const noProposals =
			options?.noProposals ?? process.env.RUMMY_NO_PROPOSALS === "1";
		const yolo = options?.yolo ?? process.env.RUMMY_YOLO === "1";
		const requestedModel = model;

		const runInfo = await this.ensureRun(
			projectId,
			model,
			run,
			prompt,
			options,
		);
		const { runId: currentRunId, alias: currentAlias } = runInfo;

		const loopSeq = await this.#db.next_loop.get({ run_id: currentRunId });
		await this.#db.enqueue_loop.get({
			run_id: currentRunId,
			sequence: loopSeq.sequence,
			mode,
			model: requestedModel,
			prompt: prompt ? prompt : "",
			config: JSON.stringify({
				noRepo,
				noInteraction,
				noWeb,
				noProposals,
				yolo,
				temperature: options?.temperature,
			}),
		});

		if (this.#activeRuns.has(currentRunId)) {
			return { run: currentAlias, status: 100 };
		}

		// Pair controller + Promise so abortAll can both signal and await drain.
		const controller = new AbortController();
		const promise = this.#drainQueue(
			currentRunId,
			currentAlias,
			projectId,
			project,
			options,
			controller,
		);
		this.#activeRuns.set(currentRunId, { controller, promise });
		return promise;
	}

	async #drainQueue(
		currentRunId,
		currentAlias,
		projectId,
		project,
		options,
		controller,
	) {
		console.error(`[DRAIN] ${currentAlias} enter (runId=${currentRunId})`);

		try {
			while (true) {
				const loop = await this.#db.claim_next_loop.get({
					run_id: currentRunId,
				});
				if (!loop) {
					console.error(`[DRAIN] ${currentAlias} queue empty — exiting`);
					break;
				}
				console.error(
					`[DRAIN] ${currentAlias} claimed loop id=${loop.id} mode=${loop.mode} seq=${loop.sequence}`,
				);

				const loopConfig = JSON.parse(loop.config);
				const hook = loop.mode === "ask" ? this.#hooks.ask : this.#hooks.act;
				const {
					noRepo = false,
					noInteraction = false,
					noWeb = false,
					noProposals = false,
					yolo = false,
				} = loopConfig;

				let result;
				try {
					result = await this.#executeLoop({
						mode: loop.mode,
						project,
						projectId,
						currentRunId,
						currentAlias,
						currentLoopId: loop.id,
						requestedModel: loop.model,
						prompt: loop.prompt,
						noRepo,
						noInteraction,
						noWeb,
						noProposals,
						yolo,
						options: { ...options, temperature: loopConfig.temperature },
						hook,
						signal: controller.signal,
					});
				} catch (err) {
					console.error(
						`[DRAIN] ${currentAlias} loop id=${loop.id} threw: ${err.message}`,
					);
					await this.#db.complete_loop.run({
						id: loop.id,
						status: 500,
						result: JSON.stringify({ error: err.message }),
					});
					throw err;
				}

				if (result.status === 413) {
					console.error(
						`[DRAIN] ${currentAlias} loop id=${loop.id} overflow=413`,
					);
					await this.#db.complete_loop.run({
						id: loop.id,
						status: 413,
						result: JSON.stringify(result),
					});
					return {
						run: currentAlias,
						status: 413,
						error: `Context full (${result.overflow} tokens over).`,
					};
				}

				console.error(
					`[DRAIN] ${currentAlias} loop id=${loop.id} completed status=${result.status}`,
				);
				await this.#db.complete_loop.run({
					id: loop.id,
					status: result.status,
					result: JSON.stringify(result),
				});
			}

			const runRow = await this.#db.get_run_by_alias.get({
				alias: currentAlias,
			});
			return { run: currentAlias, status: runRow.status };
		} finally {
			this.#activeRuns.delete(currentRunId);
		}
	}

	async #executeLoop({
		mode,
		project,
		projectId,
		currentRunId,
		currentAlias,
		currentLoopId,
		requestedModel,
		prompt,
		noRepo,
		noInteraction,
		noWeb,
		noProposals,
		yolo,
		options,
		hook,
		signal,
	}) {
		const runRow = await this.#db.get_run_by_id.get({ id: currentRunId });
		if (runRow.status !== 102) {
			await this.#setRunStatus(currentRunId, currentAlias, 102);
		}

		const modelContextSize =
			await this.#llmProvider.getContextSize(requestedModel);
		const contextSize = runRow.context_limit
			? Math.min(runRow.context_limit, modelContextSize)
			: modelContextSize;

		const toolSet = this.#hooks.tools.resolveForLoop(mode, {
			noInteraction,
			noWeb,
			noProposals,
		});

		let loopIteration = 0;
		const MAX_LOOP_TURNS = Number(process.env.RUMMY_MAX_LOOP_TURNS);

		await this.#hooks.loop.started.emit({
			runId: currentRunId,
			loopId: currentLoopId,
			mode,
			prompt,
		});

		try {
			while (loopIteration < MAX_LOOP_TURNS) {
				if (signal.aborted) {
					console.error(
						`[LOOP] ${currentAlias} iter=${loopIteration} ABORT via signal`,
					);
					await this.#setRunStatus(currentRunId, currentAlias, 499);
					const out = {
						run: currentAlias,
						status: 499,
						turn: loopIteration,
					};
					await hook.completed.emit({ projectId, ...out });
					return out;
				}
				loopIteration++;
				console.error(
					`[LOOP] ${currentAlias} iter=${loopIteration} ENTER (max=${MAX_LOOP_TURNS})`,
				);

				let turnPrompt;
				if (loopIteration === 1) {
					turnPrompt = prompt;
				} else {
					turnPrompt = this.#buildContinuationPrompt(
						loopIteration,
						MAX_LOOP_TURNS,
					);
				}

				console.error(
					`[LOOP] ${currentAlias} iter=${loopIteration} executing turn`,
				);
				const result = await this.#turnExecutor.execute({
					mode,
					project,
					projectId,
					currentRunId,
					currentAlias,
					currentLoopId,
					requestedModel,
					loopPrompt: turnPrompt,
					loopIteration,
					noRepo,
					noWeb,
					noInteraction,
					noProposals,
					yolo,
					toolSet,
					contextSize,
					options: { ...options, isContinuation: loopIteration > 1 },
					signal,
				});
				console.error(
					`[LOOP] ${currentAlias} iter=${loopIteration} turn done: status=${result.status} turn=${result.turn}`,
				);

				const verdict = await this.#hooks.error.verdict({
					store: this.#entries,
					runId: currentRunId,
					loopId: currentLoopId,
					turn: result.turn,
					recorded: result.recorded,
					summaryText: result.summaryText,
				});
				const vStatus = verdict.status === undefined ? "-" : verdict.status;
				const vReason = verdict.reason ? verdict.reason : "-";
				console.error(
					`[LOOP] ${currentAlias} iter=${loopIteration} verdict: continue=${verdict.continue} status=${vStatus} reason=${vReason}`,
				);

				await this.#hooks.run.step.completed.emit({
					projectId,
					run: currentAlias,
					turn: result.turn,
				});
				if (verdict.continue) continue;

				console.error(
					`[LOOP] ${currentAlias} iter=${loopIteration} CLOSE status=${verdict.status} reason=${vReason}`,
				);
				await this.#setRunStatus(currentRunId, currentAlias, verdict.status);
				if (verdict.reason) {
					await this.#hooks.error.log.emit({
						store: this.#entries,
						runId: currentRunId,
						turn: result.turn,
						loopId: currentLoopId,
						message: verdict.reason,
					});
				}
				const out = {
					run: currentAlias,
					status: verdict.status,
					turn: result.turn,
					reason: verdict.reason,
				};
				await hook.completed.emit({ projectId, ...out });
				return out;
			}

			console.error(
				`[LOOP] ${currentAlias} hit MAX_LOOP_TURNS=${MAX_LOOP_TURNS} — abandoning at 499`,
			);
			await this.#setRunStatus(currentRunId, currentAlias, 499);
			const out = {
				run: currentAlias,
				status: 499,
				turn: loopIteration,
			};
			await hook.completed.emit({ projectId, ...out });
			return out;
		} catch (err) {
			const status = signal.aborted ? 499 : 500;
			await this.#setRunStatus(currentRunId, currentAlias, status);
			if (status === 500) {
				await this.#hooks.error.log.emit({
					store: this.#entries,
					runId: currentRunId,
					turn: loopIteration,
					loopId: currentLoopId,
					message: `${err.message}\n${err.stack}`,
				});
			}
			const out = { run: currentAlias, status, turn: loopIteration };
			if (status === 500) out.error = err.message;
			await hook.completed.emit({ projectId, ...out });
			return out;
		} finally {
			await this.#hooks.loop.completed.emit({
				runId: currentRunId,
				loopId: currentLoopId,
				mode,
				turns: loopIteration,
			});
		}
	}

	async resolve(runAlias, resolution) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));
		const runId = runRow.id;

		const { path, action, output } = resolution;

		if (action !== "accept" && action !== "error" && action !== "reject") {
			throw new Error(msg("error.resolution_invalid", { action }));
		}

		if (action === "reject") {
			await this.#entries.set({
				runId,
				path,
				state: "failed",
				body: output ? output : "rejected",
				outcome: "permission",
			});
			await this.#hooks.proposal.rejected.emit({
				runId,
				runRow,
				path,
				output,
				db: this.#db,
				entries: this.#entries,
			});
			// Return current run status (not 200) so client doesn't close on resolve ack.
			return { run: runAlias, status: runRow.status };
		}

		const attrs = await this.#entries.getAttributes(runId, path);
		const project = await this.#db.get_project_by_id.get({
			id: runRow.project_id,
		});
		const ctx = {
			runId,
			runRow,
			projectId: runRow.project_id,
			projectRoot: project?.project_root,
			path,
			attrs,
			output,
			db: this.#db,
			entries: this.#entries,
		};

		// First plugin veto wins via proposal.accepting (e.g. readonly).
		if (action === "accept") {
			const veto = await this.#hooks.proposal.accepting.filter(null, ctx);
			if (veto?.allow === false) {
				await this.#entries.set({
					runId,
					path,
					state: "failed",
					outcome: veto.outcome,
					body: veto.body,
				});
				return { ok: true, state: "failed", outcome: veto.outcome };
			}
		}

		// proposal.content override lets plugins prefer the proposed body (e.g. set).
		const defaultBody = output ? output : "";
		const resolvedBody = await this.#hooks.proposal.content.filter(
			defaultBody,
			ctx,
		);
		const state = action === "error" ? "failed" : "resolved";
		const outcome = action === "error" ? "error" : null;
		const existing = await this.#entries.getState(runId, path);
		const existingTurn = existing?.turn === undefined ? 0 : existing.turn;
		await this.#entries.set({
			runId,
			turn: existingTurn,
			path,
			state,
			body: resolvedBody,
			outcome,
		});

		const event =
			action === "accept"
				? this.#hooks.proposal.accepted
				: this.#hooks.proposal.rejected;
		await event.emit({ ...ctx, resolvedBody });

		// Return current run status (not 200) so client doesn't close on resolve ack.
		return { run: runAlias, status: runRow.status };
	}

	async inject(runAlias, message, mode, options = {}) {
		if (mode !== "ask" && mode !== "act") {
			throw new Error(
				`inject: mode is required and must be "ask" or "act" (got ${JSON.stringify(mode)})`,
			);
		}
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));

		const noRepo = options?.noRepo ?? process.env.RUMMY_NO_REPO === "1";
		const noInteraction =
			options?.noInteraction ?? process.env.RUMMY_NO_INTERACTION === "1";
		const noWeb = options?.noWeb ?? process.env.RUMMY_NO_WEB === "1";
		const noProposals =
			options?.noProposals ?? process.env.RUMMY_NO_PROPOSALS === "1";
		const yolo = options?.yolo ?? process.env.RUMMY_YOLO === "1";

		const nextTurn = runRow.next_turn;

		await this.#entries.set({
			runId: runRow.id,
			turn: nextTurn,
			path: `prompt://${nextTurn}`,
			body: message,
			state: "resolved",
			attributes: { mode },
			writer: "plugin",
		});

		if (this.#activeRuns.has(runRow.id)) {
			return { run: runAlias, status: runRow.status, injected: "next_turn" };
		}

		const injectLoopSeq = await this.#db.next_loop.get({ run_id: runRow.id });
		await this.#db.enqueue_loop.get({
			run_id: runRow.id,
			sequence: injectLoopSeq.sequence,
			mode,
			model: runRow.model,
			prompt: message,
			config: JSON.stringify({
				noRepo,
				noInteraction,
				noWeb,
				noProposals,
				yolo,
				temperature: options?.temperature,
			}),
		});

		const projectId = runRow.project_id;
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		const controller = new AbortController();
		const promise = this.#drainQueue(
			runRow.id,
			runAlias,
			projectId,
			project,
			{},
			controller,
		);
		this.#activeRuns.set(runRow.id, { controller, promise });
		return promise;
	}

	async getRunHistory(runAlias) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));
		return this.#entries.getLog(runRow.id);
	}
}
