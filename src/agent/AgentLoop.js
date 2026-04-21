import { computeBudget } from "./budget.js";
import msg from "./messages.js";
import ResponseHealer from "./ResponseHealer.js";

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

	/**
	 * Abort every in-flight run and wait for each drain to settle.
	 * Called from server close / client teardown so the process can
	 * exit cleanly instead of leaving detached kickoff Promises
	 * pinning the event loop.
	 */
	async abortAll() {
		const promises = [];
		for (const { controller, promise } of this.#activeRuns.values()) {
			controller.abort();
			promises.push(promise);
		}
		// allSettled: drain waits for every run to finish; rejections are
		// already surfaced to whoever awaited the original run() call.
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

	async #emitRunState({
		projectId,
		runId,
		alias,
		turn,
		status,
		result = null,
	}) {
		const runUsage = await this.#db.get_run_usage.get({ run_id: runId });
		const history = await this.#entries.getLog(runId);
		const unknowns = await this.#entries.getUnknowns(runId);
		const latestSummary = history
			.filter((e) => {
				if (e.tool !== "update") return false;
				const attrs =
					typeof e.attributes === "string"
						? JSON.parse(e.attributes)
						: e.attributes;
				return attrs?.status === 200;
			})
			.at(-1);

		// Budget + context telemetry only populated when we have a real
		// turn result. Abort/crash paths without a turn return nulls
		// instead of hiding the gap with zeros.
		let budget = null;
		if (result) {
			const rows = await this.#db.get_turn_context.all({
				run_id: runId,
				turn,
			});
			budget = computeBudget({
				rows,
				contextSize: result.contextSize,
				totalTokens: result.assembledTokens,
			});
		}

		await this.#hooks.run.state.emit({
			projectId,
			run: alias,
			turn,
			status,
			summary: latestSummary?.body,
			history,
			unknowns: unknowns.map((u) => ({ path: u.path, body: u.body })),
			telemetry: {
				modelAlias: result?.modelAlias,
				model: result?.model,
				temperature: result?.temperature,
				context_size: result?.contextSize,
				context_tokens: result?.assembledTokens,
				ceiling: budget?.ceiling,
				token_usage: budget?.tokenUsage,
				tokens_free: budget?.tokensFree,
				prompt_tokens: runUsage.prompt_tokens,
				cached_tokens: runUsage.cached_tokens,
				completion_tokens: runUsage.completion_tokens,
				reasoning_tokens: runUsage.reasoning_tokens,
				total_tokens: runUsage.total_tokens,
				cost: runUsage.cost,
				context_distribution: await this.#db.get_turn_distribution.all({
					run_id: runId,
					turn,
				}),
			},
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

	async #ensureRun(projectId, model, run, prompt, options = {}) {
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

				// Clean up stale proposals from interrupted runs
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
			// Client-specified alias for a brand-new run — accept it verbatim.
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

		const noRepo = options?.noRepo === true;
		const noInteraction = options?.noInteraction === true;
		const noWeb = options?.noWeb === true;
		const noProposals = options?.noProposals === true;
		const requestedModel = model;

		const runInfo = await this.#ensureRun(
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
				temperature: options?.temperature,
			}),
		});

		if (this.#activeRuns.has(currentRunId)) {
			return { run: currentAlias, status: 100 };
		}

		// Allocate the controller + Promise pair here so `abortAll` can
		// reach both — abort the controller, await the Promise's drain.
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
		const MAX_LOOP_ITERATIONS = Number(process.env.RUMMY_MAX_TURNS);
		const healer = new ResponseHealer();

		await this.#hooks.loop.started.emit({
			runId: currentRunId,
			loopId: currentLoopId,
			mode,
			prompt,
		});

		try {
			while (loopIteration < MAX_LOOP_ITERATIONS) {
				if (signal.aborted) {
					console.error(
						`[LOOP] ${currentAlias} iter=${loopIteration} ABORT via signal`,
					);
					await this.#setRunStatus(currentRunId, currentAlias, 499);
					await this.#emitRunState({
						projectId,
						runId: currentRunId,
						alias: currentAlias,
						turn: loopIteration,
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
				console.error(
					`[LOOP] ${currentAlias} iter=${loopIteration} ENTER (max=${MAX_LOOP_ITERATIONS})`,
				);

				let turnPrompt;
				if (loopIteration === 1) {
					turnPrompt = prompt;
				} else {
					turnPrompt = this.#buildContinuationPrompt(
						loopIteration,
						MAX_LOOP_ITERATIONS,
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
					toolSet,
					contextSize,
					options: { ...options, isContinuation: loopIteration > 1 },
					signal,
				});
				console.error(
					`[LOOP] ${currentAlias} iter=${loopIteration} turn done: status=${result.status} turn=${result.turn}`,
				);

				if (result.status === 413) {
					await this.#db.complete_loop.run({
						id: currentLoopId,
						status: 413,
						result: null,
					});
					await this.#setRunStatus(currentRunId, currentAlias, 200);
					await this.#emitRunState({
						projectId,
						runId: currentRunId,
						alias: currentAlias,
						turn: result.turn,
						status: 413,
						result,
					});
					const out = {
						run: currentAlias,
						status: 413,
						overflow: result.overflow,
						assembledTokens: result.assembledTokens,
						contextSize: result.contextSize,
						turn: result.turn,
					};
					await hook.completed.emit({ projectId, ...out });
					return out;
				}

				const verdict = healer.assessTurn(result);
				const vStatus = verdict.status === undefined ? "-" : verdict.status;
				const vReason = verdict.reason ? verdict.reason : "-";
				console.error(
					`[LOOP] ${currentAlias} iter=${loopIteration} verdict: continue=${verdict.continue} status=${vStatus} reason=${vReason}`,
				);

				await this.#emitRunState({
					projectId,
					runId: currentRunId,
					alias: currentAlias,
					turn: result.turn,
					status: verdict.continue ? 102 : verdict.status,
					result,
				});
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
				`[LOOP] ${currentAlias} hit MAX_LOOP_ITERATIONS=${MAX_LOOP_ITERATIONS}`,
			);
			await this.#setRunStatus(currentRunId, currentAlias, 200);
			await this.#emitRunState({
				projectId,
				runId: currentRunId,
				alias: currentAlias,
				turn: loopIteration,
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
			const status = signal.aborted ? 499 : 500;
			await this.#setRunStatus(currentRunId, currentAlias, status);
			await this.#emitRunState({
				projectId,
				runId: currentRunId,
				alias: currentAlias,
				turn: loopIteration,
				status,
			});
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

		if (action === "accept" || action === "error") {
			const attrs = await this.#entries.getAttributes(runId, path);

			// readonly constraint enforcement: refuse to accept a set:// that
			// would rewrite a path the project has marked readonly. Bleeds
			// the refusal back to the model as state=failed outcome=readonly,
			// which it handles the same as any other rejected proposal.
			if (action === "accept" && path.startsWith("set://") && attrs?.path) {
				const File = (await import("../plugins/file/file.js")).default;
				const blocked = await File.isReadonly(
					this.#db,
					runRow.project_id,
					attrs.path,
				);
				if (blocked) {
					await this.#entries.set({
						runId,
						path,
						state: "failed",
						outcome: "readonly",
						body: `refused: ${attrs.path} is readonly`,
					});
					return { ok: true, state: "failed", outcome: "readonly" };
				}
			}

			const resolvedBody = await this.#composeResolvedContent(
				runId,
				path,
				attrs,
				output,
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

			// Store answer in attributes for ask_user
			if (path.startsWith("ask_user://") && output) {
				const turn = (await this.#db.get_run_by_id.get({ id: runId }))
					.next_turn;
				await this.#entries.set({
					runId,
					turn,
					path,
					body: resolvedBody,
					state,
					outcome,
					attributes: { ...attrs, answer: output },
				});
			}

			if (action === "accept") {
				const projectId = runRow.project_id;
				const project = await this.#db.get_project_by_id.get({
					id: projectId,
				});
				const projectRoot = project?.project_root;

				if (path.startsWith("set://") && attrs?.path && attrs?.merge) {
					const existing = await this.#entries.getBody(runId, attrs.path);
					const isNewFile = existing === null;
					const fileBody = isNewFile ? "" : existing;
					const blocks = attrs.merge.split(/(?=<<<<<<< SEARCH)/);
					let patched = fileBody;
					for (const block of blocks) {
						const m = block.match(
							/<<<<<<< SEARCH\n?([\s\S]*?)\n?=======\n?([\s\S]*?)\n?>>>>>>> REPLACE/,
						);
						if (!m) continue;
						if (m[1] === "") {
							patched = m[2];
						} else {
							patched = patched.replace(m[1], m[2]);
						}
					}
					const turn = (await this.#db.get_run_by_id.get({ id: runId }))
						.next_turn;
					await this.#entries.set({
						runId,
						turn,
						path: attrs.path,
						body: patched,
					});
					if (projectRoot) {
						const { writeFile } = await import("node:fs/promises");
						const { join } = await import("node:path");
						await writeFile(join(projectRoot, attrs.path), patched).catch(
							() => {},
						);
					}
					if (isNewFile && projectId) {
						const File = (await import("../plugins/file/file.js")).default;
						await File.setConstraint(this.#db, projectId, attrs.path, "active");
					}
				}

				if (path.startsWith("rm://")) {
					if (attrs?.path) {
						await this.#entries.rm({ runId: runId, path: attrs.path });
						if (projectRoot) {
							const { unlink } = await import("node:fs/promises");
							const { join } = await import("node:path");
							try {
								await unlink(join(projectRoot, attrs.path));
							} catch (err) {
								// File may already be absent — entry rm'd regardless.
								if (err.code !== "ENOENT") throw err;
							}
						}
					}
				}

				if (path.startsWith("mv://")) {
					if (attrs?.isMove && attrs?.from) {
						await this.#entries.rm({ runId: runId, path: attrs.from });
					}
				}

				// sh/env accept: proposal entry becomes the log entry at 200;
				// create companion data entries `{path}_1` (stdout) and
				// `{path}_2` (stderr) at status=102, demoted, empty body.
				// The stream plugin will receive chunks via the `stream` RPC
				// and append to these entries. On completion, they transition
				// to 200/500. Unix FD numbering: 1=stdout, 2=stderr.
				if (path.startsWith("sh://") || path.startsWith("env://")) {
					let command = "";
					if (attrs?.command) command = attrs.command;
					else if (attrs?.summary) command = attrs.summary;
					const turn = (await this.#db.get_run_by_id.get({ id: runId }))
						.next_turn;
					const channels = [1, 2];
					for (const ch of channels) {
						await this.#entries.set({
							runId,
							turn,
							path: `${path}_${ch}`,
							body: "",
							state: "streaming",
							visibility: "summarized",
							attributes: { command, summary: command, channel: ch },
						});
					}
					// Overwrite the log entry body with a descriptive line that
					// references the data entries. resolve() above set the state
					// to resolved; this is body replacement to make the log
					// entry self-documenting in <log>.
					await this.#entries.set({
						runId,
						path,
						state: "resolved",
						body: `ran '${command}' (in progress). Output: ${path}_1, ${path}_2`,
					});
				}
			}
		} else if (action === "reject") {
			await this.#entries.set({
				runId,
				path,
				state: "failed",
				body: output ? output : "rejected",
				outcome: "permission",
			});
		} else {
			throw new Error(msg("error.resolution_invalid", { action }));
		}

		// The dispatch loop is awaiting resolution. This unblocks it.
		// Dispatch continuation is handled by the loop, not here.
		return { run: runAlias, status: 200 };
	}

	async #composeResolvedContent(runId, path, _attrs, output) {
		const scheme = path.split("://")[0];
		switch (scheme) {
			case "set": {
				// Prefer existing body (e.g. the set result entry already has
				// the model's proposed content); fall back to the client-
				// supplied output on acceptance; empty string otherwise.
				const existing = await this.#entries.getBody(runId, path);
				if (existing) return existing;
				if (output) return output;
				return "";
			}
			default:
				return output ? output : "";
		}
	}

	async inject(runAlias, message, mode) {
		if (mode !== "ask" && mode !== "act") {
			throw new Error(
				`inject: mode is required and must be "ask" or "act" (got ${JSON.stringify(mode)})`,
			);
		}
		const runRow = await this.#db.get_run_by_alias.get({ alias: runAlias });
		if (!runRow)
			throw new Error(msg("error.run_not_found", { runId: runAlias }));

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
			config: "{}",
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
