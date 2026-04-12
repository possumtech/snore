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
		const _noRepo = options?.noRepo === true;
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
			await this.#hooks.run.created.emit({
				runId: runRow.id,
				alias,
				forkedFrom: existingRun.id,
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

		const noRepo = options?.noRepo === true;
		const noInteraction = options?.noInteraction === true;
		const noWeb = options?.noWeb === true;
		const noProposals = options?.noProposals === true;
		const requestedModel = model;

		const runInfo = await this.#ensureRun(projectId, model, run, options);
		if (runInfo.blocked) {
			return {
				run: runInfo.alias,
				status: 202,
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
			config: JSON.stringify({
				noRepo,
				noInteraction,
				noWeb,
				noProposals,
				temperature: options?.temperature,
			}),
		});

		if (this.#activeRuns.has(currentRunId)) {
			return { run: currentAlias, status: 100 };
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
		const controller = new AbortController();
		this.#activeRuns.set(currentRunId, controller);

		try {
			while (true) {
				const loop = await this.#db.claim_next_loop.get({
					run_id: currentRunId,
				});
				if (!loop) break;

				const loopConfig = loop.config ? JSON.parse(loop.config) : {};
				const hook = loop.mode === "ask" ? this.#hooks.ask : this.#hooks.act;

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
						noRepo: loopConfig.noRepo || false,
						noInteraction: loopConfig.noInteraction || false,
						noWeb: loopConfig.noWeb || false,
						noProposals: loopConfig.noProposals || false,
						options: { ...options, temperature: loopConfig.temperature },
						hook,
						signal: controller.signal,
					});
				} catch (err) {
					await this.#db.complete_loop.run({
						id: loop.id,
						status: 500,
						result: JSON.stringify({ error: err.message }),
					});
					throw err;
				}

				if (result.status === 413) {
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

				await this.#db.complete_loop.run({
					id: loop.id,
					status: result.status === 202 ? 202 : result.status,
					result: JSON.stringify(result),
				});

				if (result.status === 202) return result;
			}

			const runRow = await this.#db.get_run_by_alias.get({
				alias: currentAlias,
			});
			return { run: currentAlias, status: runRow?.status ?? 200 };
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
		options,
		hook,
		signal,
	}) {
		const runRow = await this.#db.get_run_by_id.get({ id: currentRunId });
		if (runRow.status !== 102) {
			await this.#db.update_run_status.run({
				id: currentRunId,
				status: 102,
			});
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
		const MAX_LOOP_ITERATIONS = Number(process.env.RUMMY_MAX_TURNS) || 15;
		const healer = new ResponseHealer();

		let _lastAssembledTokens = 0;
		let recovery = null; // { target, promptPath, strikes, lastTokens }

		// Previous loop entries stay at full fidelity — the model is
		// instructed to summarize and demote them. Budget enforcement
		// catches overflow if the model fails to manage context.

		// Restore any prompt entries left at summary fidelity by a recovery
		// phase that was interrupted (server crash, restart). If the full
		// prompt would overflow, Prompt Demotion on turn 1 handles it.
		await this.#knownStore.restoreSummarizedPrompts(currentRunId);

		await this.#hooks.loop.started.emit({
			runId: currentRunId,
			loopId: currentLoopId,
			mode,
			prompt,
		});

		try {
			while (loopIteration < MAX_LOOP_ITERATIONS) {
				if (signal.aborted) {
					await this.#db.update_run_status.run({
						id: currentRunId,
						status: 499,
					});
					const out = {
						run: currentAlias,
						status: 499,
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
					loopIteration,
					noRepo,
					toolSet,
					inRecovery: recovery !== null,
					contextSize,
					options: { ...options, isContinuation: loopIteration > 1 },
					signal,
				});

				if (result.status === 413) {
					if (recovery) {
						// Already in recovery — consecutive 413 counts as
						// no-progress. Do NOT pass budgetRecovery (that resets
						// strikes). Just assembledTokens so strikes accumulate.
						const ra = advanceRecovery(recovery, {
							assembledTokens:
								result.assembledTokens ?? _lastAssembledTokens,
						});
						recovery = ra.next;
						if (ra.action === "hard413") {
							await this.#db.update_run_status.run({
								id: currentRunId,
								status: 413,
							});
							const out = {
								run: currentAlias,
								status: 413,
								turn: result.turn,
							};
							await hook.completed.emit({ projectId, ...out });
							return out;
						}
						continue;
					}

					// First 413 — enter recovery. Batch-demote all full data
					// entries to create room for the model to run and self-correct.
					const demoted413 =
						await this.#db.demote_all_full.all({
							run_id: currentRunId,
						});
					const paths413 = demoted413.map((r) => r.path).join(", ");

					// Write a budget entry instructing the model to free space.
					const budgetBody = [
						"Error 413: Context Size Exceeded",
						"",
						"Required: YOU MUST demote larger and/or less relevant items to optimize your context.",
						paths413
							? `Info: ${paths413} have been automatically summarized to avoid overflow.`
							: "Info: No data entries to auto-summarize.",
						"Info: YOU MAY use bulk patterns to demote and promote entries by pattern.",
						"Info: Well-designed paths and summaries improve context management.",
						'Example: <set path="known://people/*" fidelity="summary"/>',
					].join("\n");

					await this.#knownStore.upsert(
						currentRunId,
						result.turn ?? loopIteration,
						`budget://${currentLoopId}/${loopIteration}`,
						budgetBody,
						413,
						{ loopId: currentLoopId },
					);

					const safeLevel = Math.floor(contextSize * 0.9);
					recovery = {
						target: safeLevel,
						promptPath: null,
						strikes: 0,
						lastTokens:
							result.assembledTokens ?? _lastAssembledTokens,
					};

					console.warn(
						`[RUMMY] 413 recovery: demoted ${demoted413.length} entries, target ${safeLevel} tokens`,
					);
					continue;
				}

				_lastAssembledTokens = result.assembledTokens;

				// Budget recovery: enforce progress toward context target.
				const ra = advanceRecovery(recovery, result);
				recovery = ra.next;
				if (ra.action === "restore" && ra.promptPath) {
					await this.#knownStore.setFidelity(
						currentRunId,
						ra.promptPath,
						"full",
					);
				}
				if (ra.action === "hard413") {
					await this.#db.update_run_status.run({
						id: currentRunId,
						status: 413,
					});
					const out = {
						run: currentAlias,
						status: 413,
						turn: result.turn,
					};
					await hook.completed.emit({ projectId, ...out });
					return out;
				}

				const runUsage = await this.#db.get_run_usage.get({
					run_id: currentRunId,
				});
				const history = await this.#knownStore.getLog(currentRunId);
				const unknowns = await this.#db.get_unknowns.all({
					run_id: currentRunId,
				});
				const unresolved = await this.#knownStore.getUnresolved(currentRunId);

				const latestSummary = history
					.filter((e) => e.status === 200 && e.path?.startsWith("summarize://"))
					.at(-1);

				await this.#hooks.run.state.emit({
					projectId,
					run: currentAlias,
					turn: result.turn,
					status: unresolved.length > 0 ? 202 : 102,
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
						context_tokens:
							(
								await this.#db.get_turn_context_tokens.get({
									run_id: currentRunId,
									sequence: result.turn,
								})
							)?.context_tokens ?? 0,
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
						status: 202,
					});
					const out = {
						run: currentAlias,
						status: 202,
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

				// Don't exit while budget recovery is still active.
				if (recovery !== null) continue;

				const repetition = healer.assessRepetition(result);
				if (!repetition.continue) {
					await this.#db.update_run_status.run({
						id: currentRunId,
						status: 200,
					});
					const out = {
						run: currentAlias,
						status: 200,
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
					status: 200,
				});
				const out = {
					run: currentAlias,
					status: 200,
					turn: result.turn,
				};
				await hook.completed.emit({ projectId, ...out });
				return out;
			}

			await this.#db.update_run_status.run({
				id: currentRunId,
				status: 200,
			});
			const out = {
				run: currentAlias,
				status: 200,
				turn: loopIteration,
			};
			await hook.completed.emit({ projectId, ...out });
			return out;
		} catch (err) {
			if (signal.aborted) {
				await this.#db.update_run_status.run({
					id: currentRunId,
					status: 499,
				});
				return { run: currentAlias, status: 499, turn: loopIteration };
			}
			console.warn(`[RUMMY] Run failed: ${err.message}`);
			console.warn(`[RUMMY] Stack: ${err.stack}`);
			await this.#db.update_run_status.run({
				id: currentRunId,
				status: 500,
			});
			try {
				await this.#knownStore.upsert(
					currentRunId,
					loopIteration,
					`error://${loopIteration}`,
					`${err.message}\n${err.stack}`,
					500,
					{ loopId: currentLoopId },
				);
			} catch {}
			const out = {
				run: currentAlias,
				status: 500,
				turn: loopIteration,
				error: err.message,
			};
			await hook.completed.emit({ projectId, ...out });
			return out;
		} finally {
			await this.#hooks.loop.completed
				.emit({
					runId: currentRunId,
					loopId: currentLoopId,
					mode,
					turns: loopIteration,
				})
				.catch(() => {});
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
			const status = action === "error" ? 500 : 200;
			await this.#knownStore.resolve(runId, path, status, resolvedBody);

			// Store answer in attributes for ask_user
			if (path.startsWith("ask_user://") && output) {
				const turn = (await this.#db.get_run_by_id.get({ id: runId }))
					.next_turn;
				await this.#knownStore.upsert(runId, turn, path, resolvedBody, status, {
					attributes: { ...attrs, answer: output },
				});
			}

			if (action === "accept") {
				if (path.startsWith("set://") && attrs?.file && attrs?.merge) {
					const fileBody = await this.#knownStore.getBody(runId, attrs.file);
					if (fileBody != null) {
						const blocks = attrs.merge.split(/(?=<<<<<<< SEARCH)/);
						let patched = fileBody;
						for (const block of blocks) {
							const m = block.match(
								/<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n?([\s\S]*?)\n?>>>>>>> REPLACE/,
							);
							if (m) patched = patched.replace(m[1], m[2]);
						}
						const turn = (await this.#db.get_run_by_id.get({ id: runId }))
							.next_turn;
						await this.#knownStore.upsert(
							runId,
							turn,
							attrs.file,
							patched,
							200,
						);
					}
				}

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
			await this.#knownStore.resolve(runId, path, 403, output || "rejected");
		} else {
			throw new Error(msg("error.resolution_invalid", { action }));
		}

		const unresolved = await this.#knownStore.getUnresolved(runId);
		if (unresolved.length > 0) {
			return {
				run: runAlias,
				status: 202,
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
					status: 200,
					result: null,
				});
			await this.#db.update_run_status.run({ id: runId, status: 200 });
			return { run: runAlias, status: 200 };
		}

		const hasSummary = await this.#db.get_latest_summary.get({
			run_id: runId,
			loop_id: loopId,
		});
		if (hasSummary?.body) {
			if (currentLoop)
				await this.#db.complete_loop.run({
					id: loopId,
					status: 200,
					result: null,
				});
			await this.#db.update_run_status.run({ id: runId, status: 200 });
			return { run: runAlias, status: 200 };
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
			config: currentLoop?.config || "{}",
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
			message,
			200,
			{ attributes: { mode: "ask" } },
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

/**
 * Pure recovery state transition — exported for testing.
 *
 * @param {object|null} recovery  Current recovery state (mutated copy returned).
 * @param {{ assembledTokens: number, budgetRecovery?: { target: number, promptPath: string|null } }} result
 * @returns {{ next: object|null, action: null|'restore'|'hard413', promptPath: string|null }}
 */
export function advanceRecovery(recovery, result) {
	// Initialise or update recovery state from a new Turn Demotion event.
	if (result.budgetRecovery) {
		if (!recovery) {
			recovery = {
				target: result.budgetRecovery.target,
				promptPath: result.budgetRecovery.promptPath,
				strikes: 0,
				lastTokens: result.assembledTokens,
			};
		} else {
			// Re-overflow during recovery: tighten target, don't count as strike.
			recovery = {
				...recovery,
				target: Math.min(recovery.target, result.budgetRecovery.target),
			};
		}
	}

	if (recovery === null) return { next: null, action: null, promptPath: null };

	const current = result.assembledTokens;

	if (current <= recovery.target) {
		return { next: null, action: "restore", promptPath: recovery.promptPath };
	}

	const noProgress = current >= recovery.lastTokens && !result.budgetRecovery;
	const strikes = noProgress ? recovery.strikes + 1 : 0;

	if (strikes >= 3) {
		return { next: null, action: "hard413", promptPath: null };
	}

	return {
		next: { ...recovery, strikes, lastTokens: current },
		action: null,
		promptPath: null,
	};
}
