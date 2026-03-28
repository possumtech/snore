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

	async run(
		type,
		sessionId,
		model,
		prompt,
		projectBufferFiles = null,
		runId = null,
		options = {},
	) {
		const hook = type === "ask" ? this.#hooks.ask : this.#hooks.act;
		await hook.started.emit({
			sessionId,
			model,
			prompt,
			projectBufferFiles,
			runId,
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

		// Sync editor promotions
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
		let currentRunId = runId;
		let parentRunId = null;

		if (currentRunId && isFork) {
			parentRunId = currentRunId;
			currentRunId = crypto.randomUUID();
			await this.#db.create_run.run({
				id: currentRunId,
				session_id: String(sessionId || ""),
				parent_run_id: parentRunId,
				type: String(type || "ask"),
				config: JSON.stringify({ model, noContext }),
			});
		} else if (currentRunId) {
			const existingRun = await this.#db.get_run_by_id.get({
				id: currentRunId,
			});
			if (!existingRun)
				throw new Error(msg("error.run_not_found", { runId: currentRunId }));

			const remaining = await this.#db.get_unresolved_findings.all({
				run_id: currentRunId,
			});
			if (remaining.length > 0) {
				return {
					runId: currentRunId,
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
			await this.#db.create_run.run({
				id: currentRunId,
				session_id: String(sessionId || ""),
				parent_run_id: null,
				type: String(type || "ask"),
				config: JSON.stringify({ model, noContext }),
			});
		}

		const requestedModel = model || process.env.RUMMY_MODEL_DEFAULT;

		// Always fetch model metadata (populates capabilities for schema selection).
		// Context size is also needed for budget computation in non-Lite mode.
		let contextSize = null;
		try {
			contextSize = await this.#llmProvider.getContextSize(requestedModel);
		} catch (err) {
			console.warn(
				`[RUMMY] Failed to fetch model metadata for '${requestedModel}': ${err.message}`,
			);
		}

		let inconsistencyRetries = 0;
		const MAX_INCONSISTENCY_RETRIES = 3;
		let loopIteration = 0;
		const MAX_LOOP_ITERATIONS = 15;

		// --- THE ATOMIC TURN LOOP ---
		while (loopIteration < MAX_LOOP_ITERATIONS) {
			loopIteration++;

			const turn = await this.#turnExecutor.execute({
				type,
				project,
				sessionId,
				currentRunId,
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
				turnId: turn.turnId,
				turnSequence: turn.turnSequence,
				tools: turn.tools,
				structural: turn.structural,
				elements: turn.elements,
				turnObj: turn.turnObj,
				sessionId,
			});

			await turn.turnObj.hydrate();
			await this.#hooks.run.step.completed.emit({
				runId: currentRunId,
				sessionId,
				turn: turn.turnObj,
				projectFiles: await this.#sessionManager.getFiles(project.path),
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
					runId: currentRunId,
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
				runId: currentRunId,
				status: "completed",
				turn: turn.turnSequence,
			};
		}

		return {
			runId: currentRunId,
			status: "running",
			turn: 0,
		};
	}

	async resolve(runId, resolution) {
		const run = await this.#db.get_run_by_id.get({ id: runId });
		if (!run) throw new Error(msg("error.run_not_found", { runId }));

		const { category, action } = resolution;
		const id = Number(resolution.id);

		const findings = await this.#db.get_findings_by_run_id.all({
			run_id: runId,
		});
		const finding = findings.find(
			(f) => f.category === category && f.id === id,
		);
		if (!finding)
			throw new Error(msg("error.finding_not_found", { category, id, runId }));

		if (category === "diff") {
			await this.#db.update_finding_diff_status.run({ id, status: action });
			const label =
				action === "modified"
					? msg("feedback.edits_partial")
					: msg("feedback.edits_action", { action });
			await this.#db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: finding.turn_id,
				type: "diff",
				request: finding.file || "unknown",
				result: label,
				is_error: 0,
			});
		} else if (category === "command") {
			await this.#db.update_finding_command_status.run({ id, status: action });
			await this.#db.insert_pending_context.run({
				run_id: runId,
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
				run_id: runId,
				source_turn_id: finding.turn_id,
				type: "notification",
				request: finding.patch || "prompt_user",
				result: resolution.answer || action,
				is_error: 0,
			});
		}

		const remaining = await this.#db.get_unresolved_findings.all({
			run_id: runId,
		});
		if (remaining.length > 0) {
			return {
				runId,
				status: "proposed",
				remainingCount: remaining.length,
				proposed: remaining,
			};
		}

		// All findings resolved. Determine next action.
		const allFindings = await this.#db.get_findings_by_run_id.all({
			run_id: runId,
		});

		// Rejection → stop, return control to client.
		const hasRejection = allFindings.some((f) => f.status === "rejected");
		if (hasRejection) {
			await this.#db.update_run_status.run({
				id: runId,
				status: "running",
			});
			return { runId, status: "resolved" };
		}

		// Any accepted/modified finding → auto-resume. The model needs to see
		// results: command output, edit confirmation, prompt_user response.
		const hasResolvableFinding = allFindings.some(
			(f) =>
				(f.category === "diff" || f.category === "command") &&
				(f.status === "accepted" || f.status === "modified"),
		);
		const hasRespondedPrompt = allFindings.some(
			(f) => f.category === "notification" && f.status === "responded",
		);
		if (hasResolvableFinding || hasRespondedPrompt) {
			return this.run(run.type, run.session_id, null, "", null, runId);
		}

		// No findings that need follow-up — complete.
		await this.#db.update_run_status.run({
			id: runId,
			status: "completed",
		});
		return { runId, status: "completed" };
	}

	async getRunHistory(runId) {
		const historyRows = await this.#db.get_turn_history.all({ run_id: runId });
		return historyRows.map((r) => ({ role: r.role, content: r.content }));
	}
}
