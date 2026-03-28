import crypto from "node:crypto";
import msg from "../../domain/i18n/messages.js";

export default class AgentLoop {
	#db;
	#llmProvider;
	#hooks;
	#turnExecutor;
	#findingsProcessor;
	#stateEvaluator;
	#sessionManager;

	constructor(
		db,
		llmProvider,
		hooks,
		turnExecutor,
		findingsProcessor,
		stateEvaluator,
		sessionManager,
	) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#turnExecutor = turnExecutor;
		this.#findingsProcessor = findingsProcessor;
		this.#stateEvaluator = stateEvaluator;
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
		if (!project)
			throw new Error(msg("error.project_not_found", { projectId }));

		if (Array.isArray(projectBufferFiles)) {
			await this.#db.reset_editor_promotions.run({ project_id: projectId });
			for (const path of projectBufferFiles) {
				await this.#db.upsert_editor_promotion.run({
					project_id: projectId,
					path: String(path),
				});
			}
		}

		const noContext = options?.noContext === true;
		const isFork = options?.fork === true;
		const requestedModel = model || process.env.RUMMY_MODEL_DEFAULT;

		// Resolve temperature: explicit option > session > env default
		if (options?.temperature === undefined) {
			const tempRow = await this.#db.get_session_temperature.get({ id: String(sessionId || "") });
			if (tempRow?.temperature !== null && tempRow?.temperature !== undefined) {
				options = { ...options, temperature: tempRow.temperature };
			}
		}
		let currentRunId = null;
		let currentAlias = null;
		let parentRunId = null;

		if (run && isFork) {
			const existingRun = await this.#db.get_run_by_alias.get({ alias: run });
			if (!existingRun) throw new Error(msg("error.run_not_found", { runId: run }));
			parentRunId = existingRun.id;
			currentRunId = crypto.randomUUID();
			currentAlias = await this.#generateAlias(requestedModel);
			await this.#db.create_run.run({
				id: currentRunId,
				session_id: String(sessionId || ""),
				parent_run_id: parentRunId,
				type: String(type || "ask"),
				config: JSON.stringify({ model: requestedModel, noContext }),
				alias: currentAlias,
			});
		} else if (run) {
			const existingRun = await this.#db.get_run_by_alias.get({ alias: run });
			if (!existingRun) throw new Error(msg("error.run_not_found", { runId: run }));
			currentRunId = existingRun.id;
			currentAlias = existingRun.alias;

			const remaining = await this.#db.get_unresolved_findings.all({
				run_id: currentRunId,
			});
			if (remaining.length > 0) {
				return {
					run: currentAlias,
					status: "proposed",
					remainingCount: remaining.length,
					proposed: remaining,
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

		const contextSize = await this.#llmProvider.getContextSize(requestedModel);

		let inconsistencyRetries = 0;
		const MAX_INCONSISTENCY_RETRIES = 3;
		let loopIteration = 0;
		const MAX_LOOP_ITERATIONS = 15;

		// --- THE ATOMIC TURN LOOP ---
		try {
		while (loopIteration < MAX_LOOP_ITERATIONS) {
			loopIteration++;

			const turn = await this.#turnExecutor.execute({
				type,
				project,
				sessionId,
				currentRunId,
				currentAlias,
				parentRunId,
				requestedModel,
				loopPrompt: prompt,
				noContext,
				contextSize,
				options,
			});

			// Process findings
			const findingsResult = await this.#findingsProcessor.process({
				projectPath: project.path,
				projectId,
				runId: currentRunId,
				runAlias: currentAlias,
				turnId: turn.turnId,
				turnSequence: turn.turnSequence,
				tools: turn.tools,
				structural: turn.structural,
				elements: turn.elements,
				turnObj: turn.turnObj,
				sessionId,
			});

			await turn.turnObj.hydrate();
			const runUsage = await this.#db.get_run_usage.get({ run_id: currentRunId });
			await this.#hooks.run.step.completed.emit({
				run: currentAlias,
				sessionId,
				turn: turn.turnObj,
				projectFiles: await this.#sessionManager.getFiles(project.path),
				cumulative: {
					prompt_tokens: runUsage.prompt_tokens,
					completion_tokens: runUsage.completion_tokens,
					total_tokens: runUsage.total_tokens,
					cost: runUsage.cost,
				},
			});

			// Evaluate state
			const state = await this.#stateEvaluator.evaluate({
				flags: { ...turn.flags, newReads: findingsResult.newReads },
				tools: turn.tools,
				turnJson: turn.turnJson,
				finalResponse: turn.finalResponse,
				runId: currentRunId,
				turnId: turn.turnId,
				elements: turn.elements,
				inconsistencyRetries,
				maxInconsistencyRetries: MAX_INCONSISTENCY_RETRIES,
				parsedTodo: turn.parsedTodo,
			});

			if (state.action === "proposed") {
				await this.#db.update_run_status.run({
					id: currentRunId,
					status: "proposed",
				});
				return {
					run: currentAlias,
					status: "proposed",
					turn: turn.turnSequence,
					proposed: state.proposed,
				};
			}
			if (state.action === "retry") {
				inconsistencyRetries++;
				continue;
			}
			if (state.action === "continue") {
				continue;
			}

			// Completed
			await this.#db.update_run_status.run({
				id: currentRunId,
				status: "completed",
			});
			return {
				run: currentAlias,
				status: "completed",
				turn: turn.turnSequence,
			};
		}

		return {
			run: currentAlias,
			status: "running",
			turn: 0,
		};
		} catch (err) {
			await this.#db.update_run_status.run({
				id: currentRunId,
				status: "failed",
			});
			throw err;
		}
	}

	async resolve(runAlias, resolution) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow) throw new Error(msg("error.run_not_found", { runId: runAlias }));
		const resolvedRunId = runRow.id;

		const { category, action } = resolution;
		const id = Number(resolution.id);

		const findings = await this.#db.get_findings_by_run_id.all({
			run_id: resolvedRunId,
		});
		const finding = findings.find(
			(f) => f.category === category && f.id === id,
		);
		if (!finding)
			throw new Error(msg("error.finding_not_found", { category, id, runId: resolvedRunId }));

		if (category === "diff") {
			await this.#db.update_finding_diff_status.run({ id, status: action });
			const label =
				action === "modified"
					? msg("feedback.edits_partial")
					: msg("feedback.edits_action", { action });
			await this.#db.insert_pending_context.run({
				run_id: resolvedRunId,
				source_turn_id: finding.turn_id,
				type: "diff",
				request: finding.file || "unknown",
				result: label,
				is_error: 0,
			});
		} else if (category === "command") {
			await this.#db.update_finding_command_status.run({ id, status: action });
			await this.#db.insert_pending_context.run({
				run_id: resolvedRunId,
				source_turn_id: finding.turn_id,
				type: "command",
				request: finding.patch || "unknown",
				result: resolution.output || action,
				is_error: resolution.isError ? 1 : 0,
			});
		} else if (category === "notification") {
			await this.#db.update_finding_notification_status.run({
				id,
				status: "responded",
			});
			await this.#db.insert_pending_context.run({
				run_id: resolvedRunId,
				source_turn_id: finding.turn_id,
				type: "notification",
				request: finding.patch || "prompt_user",
				result: resolution.answer || action,
				is_error: 0,
			});
		}

		const remaining = await this.#db.get_unresolved_findings.all({
			run_id: resolvedRunId,
		});
		if (remaining.length > 0) {
			return {
				run: runAlias,
				status: "proposed",
				remainingCount: remaining.length,
				proposed: remaining,
			};
		}

		// All findings resolved. Determine next action.
		const allFindings = await this.#db.get_findings_by_run_id.all({
			run_id: resolvedRunId,
		});

		// Rejection → stop, return control to client.
		const hasRejection = allFindings.some((f) => f.status === "rejected");
		if (hasRejection) {
			await this.#db.update_run_status.run({
				id: resolvedRunId,
				status: "running",
			});
			return { run: runAlias, status: "resolved" };
		}

		// Any accepted/modified finding → auto-resume.
		const hasResolvableFinding = allFindings.some(
			(f) =>
				(f.category === "diff" || f.category === "command") &&
				(f.status === "accepted" || f.status === "modified"),
		);
		const hasRespondedPrompt = allFindings.some(
			(f) => f.category === "notification" && f.status === "responded",
		);
		if (hasResolvableFinding || hasRespondedPrompt) {
			return this.run(runRow.type, runRow.session_id, null, "", null, runAlias);
		}

		// No findings that need follow-up — complete.
		await this.#db.update_run_status.run({
			id: resolvedRunId,
			status: "completed",
		});
		return { run: runAlias, status: "completed" };
	}

	async inject(runAlias, message) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow) throw new Error(msg("error.run_not_found", { runId: runAlias }));

		const isActive = runRow.status === "running" || runRow.status === "queued";

		// Get the latest turn to use as source_turn_id
		const lastSeq = await this.#db.get_last_turn_sequence.get({ run_id: runRow.id });
		const sourceTurnId = lastSeq?.last_turn_id || null;

		await this.#db.insert_pending_context.run({
			run_id: runRow.id,
			source_turn_id: sourceTurnId,
			type: "inject",
			request: "user",
			result: message,
			is_error: 0,
		});

		if (isActive) {
			return { run: runAlias, status: runRow.status, injected: "queued" };
		}

		// Idle run — resume with the injected message as context
		return this.run(runRow.type, runRow.session_id, null, "", null, runAlias);
	}

	async getRunHistory(runAlias) {
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow) throw new Error(msg("error.run_not_found", { runId: runAlias }));
		const historyRows = await this.#db.get_turn_history.all({ run_id: runRow.id });
		return historyRows.map((r) => ({ role: r.role, content: r.content }));
	}
}
