import { join } from "node:path";
import KnownStore from "./KnownStore.js";
import msg from "./messages.js";
import ResponseHealer from "./ResponseHealer.js";
import RunDumper from "./RunDumper.js";

export default class AgentLoop {
	#db;
	#llmProvider;
	#hooks;
	#turnExecutor;
	#knownStore;
	#sessionManager;
	#activeRuns = new Map();

	constructor(
		db,
		llmProvider,
		hooks,
		turnExecutor,
		knownStore,
		sessionManager,
	) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#turnExecutor = turnExecutor;
		this.#knownStore = knownStore;
		this.#sessionManager = sessionManager;
	}

	abort(runId) {
		const controller = this.#activeRuns.get(runId);
		if (controller) controller.abort();
	}

	async #generateAlias(modelAlias) {
		return `${modelAlias}_${Date.now()}`;
	}

	static toolsForMode(mode) {
		return mode === "act"
			? "unknown read env ask_user search write move copy store delete run update summary"
			: "unknown read env ask_user search write move copy drop delete update summary";
	}

	#buildContinuationPrompt(_type, turn, maxTurns, contextSize, report) {
		const parts = [];

		if (report) {
			const dist = report.contextDistribution || [];
			const usedTokens = dist.reduce((sum, b) => sum + b.tokens, 0);
			const pct = contextSize
				? Math.round((usedTokens / contextSize) * 100)
				: 0;
			const status = `Turn ${turn}/${maxTurns} · ${usedTokens} tokens (${pct}%)`;
			if (report.unknownCount > 0) {
				parts.push(
					`${status} · ${report.unknownCount} unknown${report.unknownCount > 1 ? "s" : ""} remaining`,
				);
			} else {
				parts.push(status);
			}
		} else {
			parts.push(`Turn ${turn}/${maxTurns}`);
		}

		parts.push(
			"Required: <update/> if still working, <summary/> if done. Not both.",
		);
		return parts.join("\n");
	}

	async #ensureRun(sessionId, model, run, options) {
		const noContext = options?.noContext === true;
		const isFork = options?.fork === true;
		const requestedModel = model || process.env.RUMMY_MODEL_DEFAULT;

		if (run && isFork) {
			const existingRun = await this.#db.get_run_by_alias.get({ alias: run });
			if (!existingRun)
				throw new Error(msg("error.run_not_found", { runId: run }));
			const alias = await this.#generateAlias(requestedModel);
			const runRow = await this.#db.create_run.get({
				session_id: sessionId,
				parent_run_id: existingRun.id,
				config: JSON.stringify({ model: requestedModel, noContext }),
				alias,
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
			session_id: sessionId,
			parent_run_id: null,
			config: JSON.stringify({ model: requestedModel, noContext }),
			alias,
		});
		return { runId: runRow.id, alias };
	}

	async run(
		mode,
		sessionId,
		model,
		prompt,
		projectBufferFiles = null,
		run = null,
		options = {},
	) {
		const hook = mode === "ask" ? this.#hooks.ask : this.#hooks.act;
		await hook.started.emit({
			sessionId,
			model,
			prompt,
			projectBufferFiles,
			run,
		});

		const sessions = await this.#db.get_session_by_id.all({ id: sessionId });
		if (!sessions || sessions.length === 0)
			throw new Error(msg("error.session_not_found", { sessionId }));
		const projectId = sessions[0].project_id;
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		if (!project)
			throw new Error(msg("error.project_not_found", { projectId }));

		const noContext = options?.noContext === true;
		const requestedModel = model || process.env.RUMMY_MODEL_DEFAULT;

		if (options?.temperature === undefined) {
			const tempRow = await this.#db.get_session_temperature.get({
				id: sessionId,
			});
			if (tempRow?.temperature !== null && tempRow?.temperature !== undefined) {
				options = { ...options, temperature: tempRow.temperature };
			}
		}

		const runInfo = await this.#ensureRun(sessionId, model, run, options);
		if (runInfo.blocked) {
			return {
				run: runInfo.alias,
				status: "proposed",
				remainingCount: runInfo.proposed.length,
				proposed: runInfo.proposed,
			};
		}

		const { runId: currentRunId, alias: currentAlias } = runInfo;

		// Enqueue the prompt
		await this.#db.enqueue_prompt.get({
			run_id: currentRunId,
			session_id: sessionId,
			mode,
			model: requestedModel,
			prompt: prompt || "",
			config: JSON.stringify({ noContext, temperature: options?.temperature }),
		});

		// If another loop is active for this run, the prompt is queued — return
		if (this.#activeRuns.has(currentRunId)) {
			return { run: currentAlias, status: "queued" };
		}

		// Process the queue
		return this.#drainQueue(
			currentRunId,
			currentAlias,
			sessionId,
			project,
			options,
		);
	}

	async #drainQueue(currentRunId, currentAlias, sessionId, project, options) {
		while (true) {
			const queued = await this.#db.claim_next_prompt.get({
				run_id: currentRunId,
			});
			if (!queued) break;

			const promptConfig = queued.config ? JSON.parse(queued.config) : {};
			const result = await this.#executeLoop({
				mode: queued.mode,
				project,
				sessionId,
				currentRunId,
				currentAlias,
				requestedModel: queued.model || process.env.RUMMY_MODEL_DEFAULT,
				prompt: queued.prompt,
				noContext: promptConfig.noContext || false,
				options: { ...options, temperature: promptConfig.temperature },
				hook: queued.mode === "ask" ? this.#hooks.ask : this.#hooks.act,
			});

			await this.#db.complete_prompt.run({
				id: queued.id,
				result: JSON.stringify(result),
			});

			// If the loop ended with proposals, stop draining — client must resolve first
			if (result.status === "proposed") return result;
		}

		// No more prompts — return last state
		const runRow = await this.#db.get_run_by_alias.get({ alias: currentAlias });
		return { run: currentAlias, status: runRow?.status || "completed" };
	}

	async #executeLoop({
		mode,
		project,
		sessionId,
		currentRunId,
		currentAlias,
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
		const limitRow = await this.#db.get_session_context_limit.get({
			id: sessionId,
		});
		const contextSize = limitRow?.context_limit
			? Math.min(limitRow.context_limit, modelContextSize)
			: modelContextSize;

		let loopIteration = 0;
		const MAX_LOOP_ITERATIONS = Number(process.env.RUMMY_MAX_TURNS) || 15;
		const healer = new ResponseHealer();
		let lastTurnReport = null;

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
					await hook.completed.emit({ sessionId, ...out });
					return out;
				}
				loopIteration++;

				// Build turn prompt
				let turnPrompt;
				if (loopIteration === 1) {
					turnPrompt = prompt;
				} else {
					turnPrompt = this.#buildContinuationPrompt(
						mode,
						loopIteration,
						MAX_LOOP_ITERATIONS,
						contextSize,
						lastTurnReport,
					);
				}

				const result = await this.#turnExecutor.execute({
					mode,
					project,
					sessionId,
					currentRunId,
					currentAlias,
					requestedModel,
					loopPrompt: turnPrompt,
					noContext,
					contextSize,
					options: { ...options, isContinuation: loopIteration > 1 },
					signal: controller.signal,
				});

				// Build and emit run/state notification
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
					sessionId,
					run: currentAlias,
					turn: result.turn,
					status: unresolved.length > 0 ? "proposed" : "running",
					summary: latestSummary?.value || "",
					history,
					unknowns: unknowns.map((u) => ({ path: u.path, value: u.value })),
					proposed: unresolved.map((p) => ({
						path: p.path,
						type: KnownStore.toolFromPath(p.path) || "unknown",
						meta: p.meta ? JSON.parse(p.meta) : null,
					})),
					telemetry: {
						modelAlias: result.modelAlias,
						model: result.model,
						temperature: result.temperature,
						context_size: result.contextSize,
						prompt_tokens: runUsage.prompt_tokens,
						completion_tokens: runUsage.completion_tokens,
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
					await hook.completed.emit({ sessionId, ...out });
					return out;
				}

				await this.#hooks.run.step.completed.emit({
					sessionId,
					run: currentAlias,
					turn: result.turn,
					flags: result.flags,
				});

				lastTurnReport = {
					turn: result.turn,
					flags: result.flags,
					summary: latestSummary?.value || "",
					unknownCount: unknowns.length,
					usage: runUsage,
					contextDistribution: await this.#db.get_turn_distribution.all({
						run_id: currentRunId,
						turn: result.turn,
					}),
				};

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
					await hook.completed.emit({ sessionId, ...out });
					return out;
				}

				const progress = healer.assessProgress(result);
				if (progress.continue) continue;

				// Stalled — force complete
				await this.#db.update_run_status.run({
					id: currentRunId,
					status: "completed",
				});
				const out = {
					run: currentAlias,
					status: "completed",
					turn: result.turn,
				};
				await hook.completed.emit({ sessionId, ...out });
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
			await hook.completed.emit({ sessionId, ...out });
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
			// Log the error to known_entries so it's queryable
			try {
				await this.#knownStore.upsert(
					currentRunId, loopIteration,
					`error://${loopIteration}`,
					`${err.message}\n${err.stack}`,
					"info",
				);
			} catch {}
			const out = {
				run: currentAlias,
				status: "failed",
				turn: loopIteration,
				error: err.message,
			};
			await hook.completed.emit({ sessionId, ...out });
			return out;
		} finally {
			this.#activeRuns.delete(currentRunId);
			if (process.env.RUMMY_DEBUG === "true") {
				const rummyHome = process.env.RUMMY_HOME || ".";
				try {
					await RunDumper.dump(
						this.#db,
						currentRunId,
						join(rummyHome, "last_run.txt"),
					);
				} catch {}
			}
		}
	}

	async resolve(runAlias, resolution) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));
		const runId = runRow.id;

		const { path, action, output } = resolution;

		if (action === "accept") {
			const meta = await this.#knownStore.getMeta(runId, path);
			const resolvedValue = this.#composeResolvedContent(path, meta, output);
			await this.#knownStore.resolve(runId, path, "pass", resolvedValue);

			// If accepting a delete, erase the target path
			if (path.startsWith("delete://")) {
				if (meta?.path) {
					await this.#knownStore.remove(runId, meta.path);
				}
			}

			// If accepting a move to file, remove the source entry
			if (path.startsWith("move://")) {
				if (meta?.isMove && meta?.from) {
					await this.#knownStore.remove(runId, meta.from);
				}
			}
		} else if (action === "reject") {
			await this.#knownStore.resolve(runId, path, "warn", output || "rejected");
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

		// All resolved — check for rejections
		if (await this.#knownStore.hasRejections(runId)) {
			await this.#db.update_run_status.run({ id: runId, status: "running" });
			return { run: runAlias, status: "resolved" };
		}

		// Auto-resume if any action was accepted — but not if the model already summarized
		const hasSummary = await this.#db.get_latest_summary.get({ run_id: runId });
		const hasAccepted = await this.#knownStore.hasAcceptedActions(runId);
		if (hasAccepted && !hasSummary?.value) {
			const latestPrompt = await this.#db.get_latest_prompt.get({
				run_id: runId,
			});
			const resumeMode = latestPrompt?.meta
				? JSON.parse(latestPrompt.meta).mode
				: "ask";

			const sessions = await this.#db.get_session_by_id.all({
				id: runRow.session_id,
			});
			const projectId = sessions[0].project_id;
			const project = await this.#db.get_project_by_id.get({ id: projectId });

			await this.#db.enqueue_prompt.get({
				run_id: runId,
				session_id: runRow.session_id,
				mode: resumeMode,
				model: null,
				prompt: "",
				config: "{}",
			});
			return this.#drainQueue(runId, runAlias, runRow.session_id, project, {});
		}

		await this.#db.update_run_status.run({ id: runId, status: "completed" });
		return { run: runAlias, status: "completed" };
	}

	#composeResolvedContent(path, meta, output) {
		const scheme = path.split("://")[0];
		switch (scheme) {
			case "env":
				return `<env>${meta?.command || ""}</env><output>${output || ""}</output>`;
			case "run":
				return `<run>${meta?.command || ""}</run><output>${output || ""}</output>`;
			case "ask_user":
				return `${meta?.question || ""} Answered: ${output || ""}`;
			default:
				return output || "";
		}
	}

	async inject(runAlias, message) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));

		const nextTurn = runRow.next_turn;

		// Write directly to known_entries so the next turn picks it up
		await this.#knownStore.upsert(
			runRow.id,
			nextTurn,
			`prompt://${nextTurn}`,
			"",
			"info",
			{ meta: { mode: "ask" } },
		);
		await this.#knownStore.upsert(
			runRow.id,
			nextTurn,
			`ask://${nextTurn}`,
			message,
			"info",
		);

		// If active, the next turn will see the ask:// and render <ask> instead of <progress>
		if (this.#activeRuns.has(runRow.id)) {
			return { run: runAlias, status: runRow.status, injected: "next_turn" };
		}

		// If idle, enqueue and drain to start a new loop
		await this.#db.enqueue_prompt.get({
			run_id: runRow.id,
			session_id: runRow.session_id,
			mode: "ask",
			model: null,
			prompt: message,
			config: "{}",
		});

		const sessions = await this.#db.get_session_by_id.all({
			id: runRow.session_id,
		});
		const projectId = sessions[0].project_id;
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		return this.#drainQueue(
			runRow.id,
			runAlias,
			runRow.session_id,
			project,
			{},
		);
	}

	async getRunHistory(runAlias) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));
		return this.#knownStore.getLog(runRow.id);
	}
}
