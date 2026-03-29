import crypto from "node:crypto";
import msg from "../../domain/i18n/messages.js";

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
		const MAX_LOOP_ITERATIONS = 15;

		try {
			while (loopIteration < MAX_LOOP_ITERATIONS) {
				loopIteration++;

				const result = await this.#turnExecutor.execute({
					type,
					project,
					sessionId,
					currentRunId,
					currentAlias,
					requestedModel,
					loopPrompt: prompt,
					noContext,
					contextSize,
					options,
				});

				// Emit usage
				const runUsage = await this.#db.get_run_usage.get({ run_id: currentRunId });
				await this.#hooks.run.step.completed.emit({
					run: currentAlias,
					sessionId,
					turn: result.turn,
					projectFiles: await this.#sessionManager.getFiles(project.path),
					cumulative: {
						prompt_tokens: runUsage.prompt_tokens,
						completion_tokens: runUsage.completion_tokens,
						total_tokens: runUsage.total_tokens,
						cost: runUsage.cost,
					},
				});

				// Emit proposed entries to client
				for (const call of result.actionCalls) {
					if (call.name === "edit") {
						await this.#hooks.editor.diff.emit({
							sessionId,
							run: currentAlias,
							key: call.resultKey,
							type: call.args.search ? "edit" : "create",
							file: call.args.file,
							search: call.args.search,
							replace: call.args.replace,
						});
					} else if (call.name === "run" || call.name === "delete") {
						await this.#hooks.run.command.emit({
							sessionId,
							run: currentAlias,
							key: call.resultKey,
							type: call.name,
							command: call.args.command || call.args.key,
						});
					}
				}
				if (result.promptCall) {
					await this.#hooks.ui.prompt.emit({
						sessionId,
						run: currentAlias,
						key: result.promptCall.resultKey,
						question: result.promptCall.args.question,
						options: result.promptCall.args.options,
					});
				}

				// Check for proposed entries
				const unresolved = await this.#knownStore.getUnresolved(currentRunId);
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
				if (result.flags.hasReads || result.flags.hasAct) continue;

				// Completed
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

		const { key, action, output, answer, isError } = resolution;

		if (action === "accepted" || action === "pass") {
			await this.#knownStore.resolve(runId, key, "pass", output || "");
		} else if (action === "rejected") {
			await this.#knownStore.resolve(runId, key, "warn", output || "rejected");
		} else if (action === "responded") {
			await this.#knownStore.resolve(runId, key, isError ? "error" : "pass", answer || output || "");
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
		const allResults = (await this.#knownStore.getAll(runId))
			.filter((r) => r.domain === "result");
		const hasRejection = allResults.some((r) => r.state === "warn");

		if (hasRejection) {
			await this.#db.update_run_status.run({ id: runId, status: "running" });
			return { run: runAlias, status: "resolved" };
		}

		// Auto-resume if any action was accepted
		const hasAccepted = allResults.some(
			(r) => r.state === "pass" && /^\/:(?:edit|run|delete)\//.test(r.key),
		);
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
		await this.#knownStore.upsert(runRow.id, 0, resultKey, message, "info", { source: "user" });

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
