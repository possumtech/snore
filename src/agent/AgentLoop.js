import crypto from "node:crypto";
import msg from "./messages.js";
import KnownStore from "./KnownStore.js";

export default class AgentLoop {
	#db;
	#llmProvider;
	#hooks;
	#turnExecutor;
	#knownStore;
	#sessionManager;

	constructor(db, llmProvider, hooks, turnExecutor, knownStore, sessionManager) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#turnExecutor = turnExecutor;
		this.#knownStore = knownStore;
		this.#sessionManager = sessionManager;
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
		if (!project) throw new Error(msg("error.project_not_found", { projectId }));

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
			if (!existingRun) throw new Error(msg("error.run_not_found", { runId: run }));
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
		} else if (run) {
			const existingRun = await this.#db.get_run_by_alias.get({ alias: run });
			if (!existingRun) throw new Error(msg("error.run_not_found", { runId: run }));
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

			await this.#db.update_run_status.run({ id: currentRunId, status: "running" });
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

		const contextSize = await this.#llmProvider.getContextSize(requestedModel);

		let loopIteration = 0;
		let unknownWarnings = 0;
		const MAX_LOOP_ITERATIONS = 15;
		const MAX_UNKNOWN_WARNINGS = 3;

		try {
			while (loopIteration < MAX_LOOP_ITERATIONS) {
				loopIteration++;

				// Build turn prompt: first turn = user prompt, continuation = unknown count or empty
				let turnPrompt;
				if (loopIteration === 1) {
					turnPrompt = prompt;
				} else {
					const unknownCount = await this.#knownStore.countUnknowns(currentRunId);
					turnPrompt = unknownCount > 0 ? `${unknownCount} unresolved unknown${unknownCount > 1 ? "s" : ""}.` : "";
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
						options,
					});
				} catch (err) {
					if (err.message.includes("missing required") && loopIteration < MAX_LOOP_ITERATIONS) {
						console.warn(`[RUMMY] Validation retry: ${err.message}`);
						await this.#hooks.run.progress.emit({
							sessionId, run: currentAlias, turn: loopIteration, status: "retrying",
						});
						continue;
					}
					throw err;
				}

				// Build and emit run/state notification
				const runUsage = await this.#db.get_run_usage.get({ run_id: currentRunId });
				const history = await this.#knownStore.getLog(currentRunId);
				const unknowns = await this.#db.get_unknowns.all({ run_id: currentRunId });
				const unresolved = await this.#knownStore.getUnresolved(currentRunId);

				const latestSummary = history.filter((e) => e.status === "summary").at(-1);

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
					},
				});
				if (unresolved.length > 0) {
					await this.#db.update_run_status.run({ id: currentRunId, status: "proposed" });
					return {
						run: currentAlias,
						status: "proposed",
						turn: result.turn,
						proposed: unresolved,
					};
				}

				// Continue if model made action calls (reads promote files, env gathers info)
				if (result.flags.hasReads || result.flags.hasAct) {
					unknownWarnings = 0;
					continue;
				}

				// Unknowns gate: if unknowns exist and model isn't investigating, warn and retry
				const openUnknowns = await this.#knownStore.countUnknowns(currentRunId);
				if (openUnknowns > 0 && unknownWarnings < MAX_UNKNOWN_WARNINGS) {
					unknownWarnings++;
					console.warn(`[RUMMY] Unknown warning ${unknownWarnings}/${MAX_UNKNOWN_WARNINGS}: ${openUnknowns} unresolved`);
					await this.#hooks.run.progress.emit({
						sessionId, run: currentAlias, turn: result.turn, status: "retrying",
					});
					continue;
				}

				// Completed (or gave up after max unknown warnings)
				await this.#db.update_run_status.run({ id: currentRunId, status: "completed" });
				return { run: currentAlias, status: "completed", turn: result.turn };
			}

			return { run: currentAlias, status: "running", turn: 0 };
		} catch (err) {
			await this.#db.update_run_status.run({ id: currentRunId, status: "failed" });
			throw err;
		}
	}

	async resolve(runAlias, resolution) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow) throw new Error(msg("error.run_not_found", { runId: runAlias }));
		const runId = runRow.id;

		const { key, action, output } = resolution;

		if (action === "accept") {
			await this.#knownStore.resolve(runId, key, "pass", output || "");
		} else if (action === "reject") {
			await this.#knownStore.resolve(runId, key, "warn", output || "rejected");
		} else {
			throw new Error(`Invalid resolution action: ${action}. Use 'accept' or 'reject'.`);
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
		if (!runRow) throw new Error(msg("error.run_not_found", { runId: runAlias }));

		const isActive = runRow.status === "running" || runRow.status === "queued";
		const resultKey = await this.#knownStore.nextResultKey(runRow.id, "inject");
		await this.#knownStore.upsert(runRow.id, 0, resultKey, message, "info", { meta: { source: "user" } });

		if (isActive) {
			return { run: runAlias, status: runRow.status, injected: "queued" };
		}

		return this.run(runRow.type, runRow.session_id, null, "", null, runAlias);
	}

	async getRunHistory(runAlias) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow) throw new Error(msg("error.run_not_found", { runId: runAlias }));
		return this.#knownStore.getLog(runRow.id);
	}
}
