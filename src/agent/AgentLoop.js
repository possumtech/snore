import crypto from "node:crypto";
import KnownStore from "./KnownStore.js";
import msg from "./messages.js";

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
		const prefix = `${modelAlias}_`;
		const row = await this.#db.get_next_run_alias.get({ prefix });
		return `${prefix}${row.next_seq}`;
	}

	async run(
		type,
		sessionId,
		model,
		prompt,
		projectBufferFiles = null,
		run = null,
		options = {},
	) {
		const hook = type === "ask" ? this.#hooks.ask : this.#hooks.act;
		await hook.started.emit({
			sessionId,
			model,
			prompt,
			projectBufferFiles,
			run,
		});

		const sessions = await this.#db.get_session_by_id.all({
			id: String(sessionId || ""),
		});
		if (!sessions || sessions.length === 0) {
			throw new Error(msg("error.session_not_found", { sessionId }));
		}
		const projectId = String(sessions[0].project_id || "");
		const project = await this.#db.get_project_by_id.get({ id: projectId });
		if (!project)
			throw new Error(msg("error.project_not_found", { projectId }));

		const noContext = options?.noContext === true;
		const isFork = options?.fork === true;
		const requestedModel = model || process.env.RUMMY_MODEL_DEFAULT;

		// Resolve temperature
		if (options?.temperature === undefined) {
			const tempRow = await this.#db.get_session_temperature.get({
				id: String(sessionId || ""),
			});
			if (tempRow?.temperature !== null && tempRow?.temperature !== undefined) {
				options = { ...options, temperature: tempRow.temperature };
			}
		}

		let currentRunId = null;
		let currentAlias = null;

		if (run && isFork) {
			const existingRun = await this.#db.get_run_by_alias.get({ alias: run });
			if (!existingRun)
				throw new Error(msg("error.run_not_found", { runId: run }));
			currentRunId = crypto.randomUUID();
			currentAlias = await this.#generateAlias(requestedModel);
			await this.#db.create_run.run({
				id: currentRunId,
				session_id: String(sessionId || ""),
				parent_run_id: existingRun.id,
				type: String(type || "ask"),
				config: JSON.stringify({ model: requestedModel, noContext }),
				alias: currentAlias,
			});
			// Copy parent's known store into the fork
			await this.#db.fork_known_entries.run({
				new_run_id: currentRunId,
				parent_run_id: existingRun.id,
			});
		} else if (run) {
			const existingRun = await this.#db.get_run_by_alias.get({ alias: run });
			if (!existingRun)
				throw new Error(msg("error.run_not_found", { runId: run }));
			currentRunId = existingRun.id;
			currentAlias = existingRun.alias;

			const unresolved = await this.#knownStore.getUnresolved(currentRunId);
			if (unresolved.length > 0) {
				return {
					run: currentAlias,
					status: "proposed",
					remainingCount: unresolved.length,
					proposed: unresolved,
				};
			}

			await this.#db.update_run_status.run({
				id: currentRunId,
				status: "running",
			});
		} else {
			currentRunId = crypto.randomUUID();
			currentAlias = await this.#generateAlias(requestedModel);
			await this.#db.create_run.run({
				id: currentRunId,
				session_id: String(sessionId || ""),
				parent_run_id: null,
				type: String(type || "ask"),
				config: JSON.stringify({ model: requestedModel, noContext }),
				alias: currentAlias,
			});
		}

		const modelContextSize = await this.#llmProvider.getContextSize(requestedModel);
		const limitRow = await this.#db.get_session_context_limit.get({ id: String(sessionId || "") });
		const contextSize = limitRow?.context_limit
			? Math.min(limitRow.context_limit, modelContextSize)
			: modelContextSize;

		let loopIteration = 0;
		let unknownWarnings = 0;
		let lastSummaryText = null;
		let repetitionCount = 0;
		const MAX_LOOP_ITERATIONS = Number(process.env.RUMMY_MAX_TURNS) || 15;
		const MAX_UNKNOWN_WARNINGS = Number(process.env.RUMMY_MAX_UNKNOWN_WARNINGS) || 3;
		const MAX_REPETITIONS = Number(process.env.RUMMY_MAX_REPETITIONS) || 3;

		const controller = new AbortController();
		this.#activeRuns.set(currentRunId, controller);

		try {
			while (loopIteration < MAX_LOOP_ITERATIONS) {
				if (controller.signal.aborted) {
					await this.#db.update_run_status.run({ id: currentRunId, status: "aborted" });
					const out = { run: currentAlias, status: "aborted", turn: loopIteration };
					await hook.completed.emit({ sessionId, ...out });
					return out;
				}
				loopIteration++;

				// Build turn prompt
				let turnPrompt;
				if (loopIteration === 1) {
					turnPrompt = prompt;
				} else {
					const unknownCount =
						await this.#knownStore.countUnknowns(currentRunId);
					const allowed =
						type === "act"
							? "<unknown/> <known/> <read/> <drop/> <edit/> <delete/> <run/> <env/> <ask_user/> <summary/>"
							: "<unknown/> <known/> <read/> <drop/> <env/> <ask_user/> <summary/>";
					const parts = [];
					if (unknownCount > 0) {
						parts.push(
							`${unknownCount} unresolved unknown${unknownCount > 1 ? "s" : ""}. Use <read/> or <env/> to investigate, or <drop/> to dismiss.`,
						);
					}
					parts.push(`Allowed: ${allowed}`);
					parts.push("Required: <summary/>");
					turnPrompt = parts.join("\n");
				}

				let result;
				try {
					result = await this.#turnExecutor.execute({
						type,
						project,
						sessionId,
						currentRunId,
						currentAlias,
						requestedModel,
						loopPrompt: turnPrompt,
						noContext,
						contextSize,
						options: { ...options, isContinuation: loopIteration > 1 },
					});
				} catch (err) {
					if (
						err.message.includes("missing required") &&
						loopIteration < MAX_LOOP_ITERATIONS
					) {
						console.warn(`[RUMMY] Validation retry: ${err.message}`);
						await this.#hooks.run.progress.emit({
							sessionId,
							run: currentAlias,
							turn: loopIteration,
							status: "retrying",
						});
						continue;
					}
					throw err;
				}

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
					unknowns: unknowns.map((u) => ({ key: u.key, value: u.value })),
					proposed: unresolved.map((p) => ({
						key: p.key,
						type: KnownStore.toolFromKey(p.key) || "unknown",
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
						context_distribution: await this.#knownStore.getContextDistribution(currentRunId),
					},
				});
				if (unresolved.length > 0) {
					await this.#db.update_run_status.run({
						id: currentRunId,
						status: "proposed",
					});
					const out = { run: currentAlias, status: "proposed", turn: result.turn, proposed: unresolved };
					await hook.completed.emit({ sessionId, ...out });
					return out;
				}

				await this.#hooks.run.step.completed.emit({
					sessionId,
					run: currentAlias,
					turn: result.turn,
					flags: result.flags,
				});

				// Repetition detection: same summary + no new actions = stuck
				if (result.summaryText === lastSummaryText && !result.flags.hasAct && !result.flags.hasReads) {
					repetitionCount++;
					if (repetitionCount >= MAX_REPETITIONS) {
						console.warn(`[RUMMY] Repetition detected: "${result.summaryText?.slice(0, 60)}" repeated ${repetitionCount} times. Force-completing.`);
						const staleUnknowns = await this.#db.get_unknowns.all({ run_id: currentRunId });
						for (const u of staleUnknowns) {
							await this.#knownStore.demote(currentRunId, u.key);
						}
						await this.#db.update_run_status.run({ id: currentRunId, status: "completed" });
						const out = { run: currentAlias, status: "completed", turn: result.turn };
						await hook.completed.emit({ sessionId, ...out });
						return out;
					}
				} else {
					repetitionCount = 0;
				}
				lastSummaryText = result.summaryText;

				// Continue if model made action calls (reads promote files, env gathers info)
				if (result.flags.hasReads || result.flags.hasAct) {
					unknownWarnings = 0;
					continue;
				}

				// Unknowns gate: if unknowns exist and model isn't investigating, warn and retry
				const openUnknowns = await this.#knownStore.countUnknowns(currentRunId);
				if (openUnknowns > 0 && unknownWarnings < MAX_UNKNOWN_WARNINGS) {
					unknownWarnings++;
					console.warn(
						`[RUMMY] Unknown warning ${unknownWarnings}/${MAX_UNKNOWN_WARNINGS}: ${openUnknowns} unresolved`,
					);
					await this.#hooks.run.progress.emit({
						sessionId,
						run: currentAlias,
						turn: result.turn,
						status: "retrying",
					});
					continue;
				}

				// Completed (or gave up after max unknown warnings)
				await this.#db.update_run_status.run({
					id: currentRunId,
					status: "completed",
				});
				const out = { run: currentAlias, status: "completed", turn: result.turn };
				await hook.completed.emit({ sessionId, ...out });
				return out;
			}

			const out = { run: currentAlias, status: "running", turn: 0 };
			await hook.completed.emit({ sessionId, ...out });
			return out;
		} catch (err) {
			if (controller.signal.aborted) {
				await this.#db.update_run_status.run({ id: currentRunId, status: "aborted" });
				return { run: currentAlias, status: "aborted", turn: loopIteration };
			}
			await this.#db.update_run_status.run({
				id: currentRunId,
				status: "failed",
			});
			await hook.completed.emit({ sessionId, run: currentAlias, status: "failed", error: err.message });
			throw err;
		} finally {
			this.#activeRuns.delete(currentRunId);
		}
	}

	async resolve(runAlias, resolution) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));
		const runId = runRow.id;

		const { key, action, output } = resolution;

		if (action === "accept") {
			await this.#knownStore.resolve(runId, key, "pass", output || "");

			// If accepting a delete, erase the target file key
			if (key.startsWith("/:delete:")) {
				const meta = await this.#knownStore.getMeta(runId, key);
				if (meta?.key) {
					await this.#knownStore.remove(runId, meta.key);
				}
			}
		} else if (action === "reject") {
			await this.#knownStore.resolve(runId, key, "warn", output || "rejected");
		} else {
			throw new Error(
				msg("error.resolution_invalid", { action }),
			);
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

		// Auto-resume if any action was accepted
		const hasAccepted = await this.#knownStore.hasAcceptedActions(runId);
		if (hasAccepted) {
			return this.run(runRow.type, runRow.session_id, null, "", null, runAlias);
		}

		await this.#db.update_run_status.run({ id: runId, status: "completed" });
		return { run: runAlias, status: "completed" };
	}

	async inject(runAlias, message) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));

		const isActive = runRow.status === "running" || runRow.status === "queued";
		const resultKey = await this.#knownStore.nextResultKey(runRow.id, "inject");
		await this.#knownStore.upsert(runRow.id, 0, resultKey, message, "info", {
			meta: { source: "user" },
		});

		if (isActive) {
			return { run: runAlias, status: runRow.status, injected: "queued" };
		}

		return this.run(runRow.type, runRow.session_id, null, "", null, runAlias);
	}

	async getRunHistory(runAlias) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));
		return this.#knownStore.getLog(runRow.id);
	}
}
