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
			await this.#knownStore.forkEntries(existingRun.id, runRow.id);
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

			// Clean up stale proposals from interrupted runs
			const unresolved = await this.#knownStore.getUnresolved(existingRun.id);
			for (const u of unresolved) {
				await this.#knownStore.set({
					runId: existingRun.id,
					path: u.path,
					state: "cancelled",
					body: "Stale proposal from interrupted run",
					outcome: "interrupted",
				});
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
					status: result.status,
					result: JSON.stringify(result),
				});
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

		// Previous loop entries stay at full fidelity — the model is
		// instructed to demote them. Budget enforcement catches overflow
		// if the model fails to manage context.

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
					contextSize,
					options: { ...options, isContinuation: loopIteration > 1 },
					signal,
				});

				if (result.status === 413) {
					await this.#db.complete_loop.run({
						id: currentLoopId,
						status: 413,
						result: null,
					});
					await this.#db.update_run_status.run({
						id: currentRunId,
						status: 200,
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

				_lastAssembledTokens = result.assembledTokens;

				const runUsage = await this.#db.get_run_usage.get({
					run_id: currentRunId,
				});
				const history = await this.#knownStore.getLog(currentRunId);
				const unknowns = await this.#knownStore.getUnknowns(currentRunId);
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

				await this.#hooks.run.state.emit({
					projectId,
					run: currentAlias,
					turn: result.turn,
					status: 102,
					summary: latestSummary?.body || "",
					history,
					unknowns: unknowns.map((u) => ({ path: u.path, body: u.body })),
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
				await this.#hooks.run.step.completed.emit({
					projectId,
					run: currentAlias,
					turn: result.turn,
				});

				const repetition = healer.assessRepetition(result.recorded);
				if (!repetition.continue) {
					await this.#hooks.error.log.emit({
						store: this.#knownStore,
						runId: currentRunId,
						turn: result.turn,
						loopId: currentLoopId,
						message: repetition.reason,
					});
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
				if (progress.reason) {
					await this.#hooks.error.log.emit({
						store: this.#knownStore,
						runId: currentRunId,
						turn: result.turn,
						loopId: currentLoopId,
						message: progress.reason,
					});
				}
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
			await this.#db.update_run_status.run({
				id: currentRunId,
				status: 500,
			});
			try {
				await this.#hooks.error.log.emit({
					store: this.#knownStore,
					runId: currentRunId,
					turn: loopIteration,
					loopId: currentLoopId,
					message: `${err.message}\n${err.stack}`,
				});
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
			const state = action === "error" ? "failed" : "resolved";
			const outcome = action === "error" ? "error" : null;
			await this.#knownStore.set({
				runId,
				path,
				state,
				body: resolvedBody,
				outcome,
			});

			// Store answer in attributes for ask_user
			if (path.startsWith("ask_user://") && output) {
				const turn = (await this.#db.get_run_by_id.get({ id: runId }))
					.next_turn;
				await this.#knownStore.set({
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
					const existing = await this.#knownStore.getBody(runId, attrs.path);
					const isNewFile = existing == null;
					const fileBody = existing ?? "";
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
					await this.#knownStore.set({
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
						await this.#knownStore.rm({ runId: runId, path: attrs.path });
						if (projectRoot) {
							const { unlink } = await import("node:fs/promises");
							const { join } = await import("node:path");
							await unlink(join(projectRoot, attrs.path)).catch(() => {});
						}
					}
				}

				if (path.startsWith("mv://")) {
					if (attrs?.isMove && attrs?.from) {
						await this.#knownStore.rm({ runId: runId, path: attrs.from });
					}
				}

				// sh/env accept: proposal entry becomes the log entry at 200;
				// create companion data entries `{path}_1` (stdout) and
				// `{path}_2` (stderr) at status=102, demoted, empty body.
				// The stream plugin will receive chunks via the `stream` RPC
				// and append to these entries. On completion, they transition
				// to 200/500. Unix FD numbering: 1=stdout, 2=stderr.
				if (path.startsWith("sh://") || path.startsWith("env://")) {
					const command = attrs?.command || attrs?.summary || "";
					const turn = (await this.#db.get_run_by_id.get({ id: runId }))
						.next_turn;
					const channels = [1, 2];
					for (const ch of channels) {
						await this.#knownStore.set({
							runId,
							turn,
							path: `${path}_${ch}`,
							body: "",
							state: "streaming",
							fidelity: "demoted",
							attributes: { command, summary: command, channel: ch },
						});
					}
					// Overwrite the log entry body with a descriptive line that
					// references the data entries. resolve() above set the state
					// to resolved; this is body replacement to make the log
					// entry self-documenting in <performed>.
					await this.#knownStore.set({
						runId,
						path,
						state: "resolved",
						body: `ran '${command}' (in progress). Output: ${path}_1, ${path}_2`,
					});
				}
			}
		} else if (action === "reject") {
			await this.#knownStore.set({
				runId,
				path,
				state: "failed",
				body: output || "rejected",
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

		await this.#knownStore.set({
			runId: runRow.id,
			turn: nextTurn,
			path: `prompt://${nextTurn}`,
			body: message,
			state: "resolved",
			attributes: { mode: "ask" },
			writer: "plugin",
		});

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
