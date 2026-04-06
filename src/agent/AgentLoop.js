import KnownStore from "./KnownStore.js";
import msg from "./messages.js";
import ResponseHealer from "./ResponseHealer.js";

export default class AgentLoop {
	#db;
	#llmProvider;
	#hooks;
	#turnExecutor;
	#knownStore;
	#activeRuns = new Map();

	constructor(db, llmProvider, hooks, turnExecutor, knownStore) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#turnExecutor = turnExecutor;
		this.#knownStore = knownStore;
	}

	abort(runId) {
		const controller = this.#activeRuns.get(runId);
		if (controller) controller.abort();
	}

	async #generateAlias(modelAlias) {
		return `${modelAlias}_${Date.now()}`;
	}

	#buildContinuationPrompt(turn, maxTurns) {
		return `Turn ${turn}/${maxTurns}`;
	}

	async #ensureRun(projectId, model, run, options) {
		const _noContext = options?.noContext === true;
		const isFork = options?.fork === true;
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
				temperature: options?.temperature ?? null,
				persona: options?.persona ?? null,
				context_limit: options?.contextLimit ?? null,
			});
			await this.#db.fork_known_entries.run({
				new_run_id: runRow.id,
				parent_run_id: existingRun.id,
			});
			return { runId: runRow.id, alias };
		}

		if (run) {
			const existingRun = await this.#db.get_run_by_alias.get({ alias: run });
			if (!existingRun)
				throw new Error(msg("error.run_not_found", { runId: run }));

			const existing = this.#activeRuns.get(existingRun.id);
			if (existing) existing.abort();

			const unresolved = await this.#knownStore.getUnresolved(existingRun.id);
			if (unresolved.length > 0) {
				return {
					runId: existingRun.id,
					alias: existingRun.alias,
					blocked: true,
					proposed: unresolved,
				};
			}
			return { runId: existingRun.id, alias: existingRun.alias };
		}

		const alias = await this.#generateAlias(requestedModel);
		const runRow = await this.#db.create_run.get({
			project_id: projectId,
			parent_run_id: null,
			model: requestedModel,
			alias,
			temperature: options?.temperature ?? null,
			persona: options?.persona ?? null,
			context_limit: options?.contextLimit ?? null,
		});
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

		const noContext = options?.noContext === true;
		const requestedModel = model;

		const runInfo = await this.#ensureRun(projectId, model, run, options);
		if (runInfo.blocked) {
			return {
				run: runInfo.alias,
				status: "proposed",
				remainingCount: runInfo.proposed.length,
				proposed: runInfo.proposed,
			};
		}

		const { runId: currentRunId, alias: currentAlias } = runInfo;

		const loopSeq = await this.#db.next_loop.get({ run_id: currentRunId });
		await this.#db.enqueue_loop.get({
			run_id: currentRunId,
			sequence: loopSeq.sequence,
			mode,
			model: requestedModel,
			prompt: prompt || "",
			config: JSON.stringify({ noContext, temperature: options?.temperature }),
		});

		if (this.#activeRuns.has(currentRunId)) {
			return { run: currentAlias, status: "queued" };
		}

		return this.#drainQueue(
			currentRunId,
			currentAlias,
			projectId,
			project,
			options,
		);
	}

	async #drainQueue(currentRunId, currentAlias, projectId, project, options) {
		while (true) {
			const loop = await this.#db.claim_next_loop.get({
				run_id: currentRunId,
			});
			if (!loop) break;

			const loopConfig = loop.config ? JSON.parse(loop.config) : {};
			const result = await this.#executeLoop({
				mode: loop.mode,
				project,
				projectId,
				currentRunId,
				currentAlias,
				currentLoopId: loop.id,
				requestedModel: loop.model,
				prompt: loop.prompt,
				noContext: loopConfig.noContext || false,
				options: { ...options, temperature: loopConfig.temperature },
				hook: loop.mode === "ask" ? this.#hooks.ask : this.#hooks.act,
			});

			await this.#db.complete_loop.run({
				id: loop.id,
				status: result.status === "proposed" ? "proposed" : result.status,
				result: JSON.stringify(result),
			});

			if (result.status === "proposed") return result;
		}

		const runRow = await this.#db.get_run_by_alias.get({ alias: currentAlias });
		return { run: currentAlias, status: runRow?.status || "completed" };
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
		noContext,
		options,
		hook,
	}) {
		const runRow = await this.#db.get_run_by_id.get({ id: currentRunId });
		if (runRow.status !== "running") {
			await this.#db.update_run_status.run({
				id: currentRunId,
				status: "running",
			});
		}

		const modelContextSize =
			await this.#llmProvider.getContextSize(requestedModel);
		const contextSize = runRow.context_limit
			? Math.min(runRow.context_limit, modelContextSize)
			: modelContextSize;

		let loopIteration = 0;
		const MAX_LOOP_ITERATIONS = Number(process.env.RUMMY_MAX_TURNS) || 15;
		const healer = new ResponseHealer();

		const controller = new AbortController();
		this.#activeRuns.set(currentRunId, controller);

		try {
			while (loopIteration < MAX_LOOP_ITERATIONS) {
				if (controller.signal.aborted) {
					await this.#db.update_run_status.run({
						id: currentRunId,
						status: "aborted",
					});
					const out = {
						run: currentAlias,
						status: "aborted",
						turn: loopIteration,
					};
					await hook.completed.emit({ projectId, ...out });
					return out;
				}
				loopIteration++;

				let turnPrompt;
				if (loopIteration === 1) {
					turnPrompt = prompt;
				} else {
					turnPrompt = this.#buildContinuationPrompt(
						loopIteration,
						MAX_LOOP_ITERATIONS,
					);
				}

				const result = await this.#turnExecutor.execute({
					mode,
					project,
					projectId,
					currentRunId,
					currentAlias,
					currentLoopId,
					requestedModel,
					loopPrompt: turnPrompt,
					noContext,
					contextSize,
					options: { ...options, isContinuation: loopIteration > 1 },
					signal: controller.signal,
				});

				const runUsage = await this.#db.get_run_usage.get({
					run_id: currentRunId,
				});
				const history = await this.#knownStore.getLog(currentRunId);
				const unknowns = await this.#db.get_unknowns.all({
					run_id: currentRunId,
				});
				const unresolved = await this.#knownStore.getUnresolved(currentRunId);

				const latestSummary = history
					.filter((e) => e.status === "summary")
					.at(-1);

				await this.#hooks.run.state.emit({
					projectId,
					run: currentAlias,
					turn: result.turn,
					status: unresolved.length > 0 ? "proposed" : "running",
					summary: latestSummary?.body || "",
					history,
					unknowns: unknowns.map((u) => ({ path: u.path, body: u.body })),
					proposed: unresolved.map((p) => ({
						path: p.path,
						type: KnownStore.toolFromPath(p.path) || "unknown",
						attributes: p.attributes ? JSON.parse(p.attributes) : null,
					})),
					telemetry: {
						modelAlias: result.modelAlias,
						model: result.model,
						temperature: result.temperature,
						context_size: result.contextSize,
						prompt_tokens: runUsage.prompt_tokens,
						cached_tokens: runUsage.cached_tokens,
						completion_tokens: runUsage.completion_tokens,
						reasoning_tokens: runUsage.reasoning_tokens,
						total_tokens: runUsage.total_tokens,
						cost: runUsage.cost,
						context_distribution: await this.#db.get_turn_distribution.all({
							run_id: currentRunId,
							turn: result.turn,
						}),
					},
				});
				if (unresolved.length > 0) {
					await this.#db.update_run_status.run({
						id: currentRunId,
						status: "proposed",
					});
					const out = {
						run: currentAlias,
						status: "proposed",
						turn: result.turn,
						proposed: unresolved,
					};
					await hook.completed.emit({ projectId, ...out });
					return out;
				}

				await this.#hooks.run.step.completed.emit({
					projectId,
					run: currentAlias,
					turn: result.turn,
					flags: result.flags,
				});

				const repetition = healer.assessRepetition(result);
				if (!repetition.continue) {
					await this.#db.update_run_status.run({
						id: currentRunId,
						status: "completed",
					});
					const out = {
						run: currentAlias,
						status: "completed",
						turn: result.turn,
						reason: repetition.reason,
					};
					await hook.completed.emit({ projectId, ...out });
					return out;
				}

				const progress = healer.assessProgress(result);
				if (progress.continue) continue;

				await this.#db.update_run_status.run({
					id: currentRunId,
					status: "completed",
				});
				const out = {
					run: currentAlias,
					status: "completed",
					turn: result.turn,
				};
				await hook.completed.emit({ projectId, ...out });
				return out;
			}

			await this.#db.update_run_status.run({
				id: currentRunId,
				status: "completed",
			});
			const out = {
				run: currentAlias,
				status: "completed",
				turn: loopIteration,
			};
			await hook.completed.emit({ projectId, ...out });
			return out;
		} catch (err) {
			if (controller.signal.aborted) {
				await this.#db.update_run_status.run({
					id: currentRunId,
					status: "aborted",
				});
				return { run: currentAlias, status: "aborted", turn: loopIteration };
			}
			console.warn(`[RUMMY] Run failed: ${err.message}`);
			console.warn(`[RUMMY] Stack: ${err.stack}`);
			await this.#db.update_run_status.run({
				id: currentRunId,
				status: "failed",
			});
			try {
				await this.#knownStore.upsert(
					currentRunId,
					loopIteration,
					`error://${loopIteration}`,
					`${err.message}\n${err.stack}`,
					"info",
					{ loopId: currentLoopId },
				);
			} catch {}
			const out = {
				run: currentAlias,
				status: "failed",
				turn: loopIteration,
				error: err.message,
			};
			await hook.completed.emit({ projectId, ...out });
			return out;
		} finally {
			this.#activeRuns.delete(currentRunId);
		}
	}

	async resolve(runAlias, resolution) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));
		const runId = runRow.id;

		const { path, action, output } = resolution;

		if (action === "accept" || action === "error") {
			const attrs = await this.#knownStore.getAttributes(runId, path);
			const resolvedBody = await this.#composeResolvedContent(
				runId,
				path,
				attrs,
				output,
			);
			const state = action === "error" ? "error" : "pass";
			await this.#knownStore.resolve(runId, path, state, resolvedBody);

			// Store answer in attributes for ask_user
			if (path.startsWith("ask_user://") && output) {
				const turn = (await this.#db.get_run_by_id.get({ id: runId }))
					.next_turn;
				await this.#knownStore.upsert(runId, turn, path, resolvedBody, state, {
					attributes: { ...attrs, answer: output },
				});
			}

			if (action === "accept") {
				if (path.startsWith("rm://")) {
					if (attrs?.path) {
						await this.#knownStore.remove(runId, attrs.path);
					}
				}

				if (path.startsWith("mv://")) {
					if (attrs?.isMove && attrs?.from) {
						await this.#knownStore.remove(runId, attrs.from);
					}
				}
			}
		} else if (action === "reject") {
			await this.#knownStore.resolve(
				runId,
				path,
				"rejected",
				output || "rejected",
			);
		} else {
			throw new Error(msg("error.resolution_invalid", { action }));
		}

		const unresolved = await this.#knownStore.getUnresolved(runId);
		if (unresolved.length > 0) {
			return {
				run: runAlias,
				status: "proposed",
				remainingCount: unresolved.length,
				proposed: unresolved,
			};
		}

		// Scope completion checks to the current loop
		const currentLoop = await this.#db.get_current_loop.get({ run_id: runId });
		const loopId = currentLoop?.id ?? null;

		if (await this.#knownStore.hasRejections(runId, loopId)) {
			if (currentLoop)
				await this.#db.complete_loop.run({
					id: loopId,
					status: "completed",
					result: null,
				});
			await this.#db.update_run_status.run({ id: runId, status: "completed" });
			return { run: runAlias, status: "completed" };
		}

		const hasSummary = await this.#db.get_latest_summary.get({
			run_id: runId,
			loop_id: loopId,
		});
		if (hasSummary?.body) {
			if (currentLoop)
				await this.#db.complete_loop.run({
					id: loopId,
					status: "completed",
					result: null,
				});
			await this.#db.update_run_status.run({ id: runId, status: "completed" });
			return { run: runAlias, status: "completed" };
		}

		// No summary and no rejections in this loop — resume it
		const projectId = runRow.project_id;
		const project = await this.#db.get_project_by_id.get({ id: projectId });

		const latestPrompt = await this.#db.get_latest_prompt.get({
			run_id: runId,
		});
		const resumeMode = latestPrompt?.attributes
			? JSON.parse(latestPrompt.attributes).mode
			: "ask";

		// Re-enqueue the current loop's prompt to continue it
		const loopSeq = await this.#db.next_loop.get({ run_id: runId });
		await this.#db.enqueue_loop.get({
			run_id: runId,
			sequence: loopSeq.sequence,
			mode: resumeMode,
			model: runRow.model,
			prompt: "",
			config: "{}",
		});
		return this.#drainQueue(runId, runAlias, projectId, project, {});
	}

	async #composeResolvedContent(runId, path, _attrs, output) {
		const scheme = path.split("://")[0];
		switch (scheme) {
			case "set": {
				const existing = await this.#knownStore.getBody(runId, path);
				return existing || output || "";
			}
			default:
				return output || "";
		}
	}

	async inject(runAlias, message) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));

		const nextTurn = runRow.next_turn;

		await this.#knownStore.upsert(
			runRow.id,
			nextTurn,
			`prompt://${nextTurn}`,
			"",
			"info",
			{ attributes: { mode: "ask" } },
		);
		await this.#knownStore.upsert(
			runRow.id,
			nextTurn,
			`ask://${nextTurn}`,
			message,
			"info",
		);

		if (this.#activeRuns.has(runRow.id)) {
			return { run: runAlias, status: runRow.status, injected: "next_turn" };
		}

		const injectLoopSeq = await this.#db.next_loop.get({ run_id: runRow.id });
		await this.#db.enqueue_loop.get({
			run_id: runRow.id,
			sequence: injectLoopSeq.sequence,
			mode: "ask",
			model: runRow.model,
			prompt: message,
			config: "{}",
		});

		const projectId = runRow.project_id;
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		return this.#drainQueue(runRow.id, runAlias, projectId, project, {});
	}

	async getRunHistory(runAlias) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));
		return this.#knownStore.getLog(runRow.id);
	}
}
