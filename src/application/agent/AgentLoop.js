import crypto from "node:crypto";
import Turn from "../../domain/turn/Turn.js";

/**
 * AgentLoop: Coordinates the autonomous Rumsfeld Loop.
 * The database is the single source of truth for every tag and state change.
 * The server never touches the filesystem — all diffs and commands are proposed
 * to the client, which resolves them and reports back.
 */
export default class AgentLoop {
	#db;
	#llmProvider;
	#hooks;
	#turnBuilder;
	#responseParser;
	#findingsManager;
	#sessionManager;

	constructor(
		db,
		llmProvider,
		hooks,
		turnBuilder,
		responseParser,
		findingsManager,
		sessionManager,
	) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#turnBuilder = turnBuilder;
		this.#responseParser = responseParser;
		this.#findingsManager = findingsManager;
		this.#sessionManager = sessionManager;
	}

	#resolveAlias(modelId) {
		if (!modelId) return modelId;
		if (process.env[`RUMMY_MODEL_${modelId}`]) return modelId;
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("RUMMY_MODEL_") && process.env[key] === modelId)
				return key.replace("RUMMY_MODEL_", "");
		}
		return modelId;
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
			throw new Error(`Session '${sessionId}' not found.`);
		}
		const projectId = String(sessions[0].project_id || "");
		const project = await this.#db.get_project_by_id.get({
			id: projectId,
		});

		if (!project) {
			throw new Error(`Project '${projectId}' not found.`);
		}

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

		let currentRunId = runId;

		if (currentRunId) {
			const existingRun = await this.#db.get_run_by_id.get({
				id: currentRunId,
			});
			if (!existingRun) throw new Error(`Run '${currentRunId}' not found.`);

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
				type: String(type || "ask"),
				config: JSON.stringify({ model }),
			});
		}

		const loopPrompt = prompt;
		const requestedModel = model || process.env.RUMMY_MODEL_DEFAULT;
		let protocolRetries = 0;
		const MAX_PROTOCOL_RETRIES = 5;
		let currentTurnSequence = 0;
		let loopIteration = 0;
		const MAX_LOOP_ITERATIONS = 15;

		// --- THE ATOMIC TURN LOOP ---
		while (loopIteration < MAX_LOOP_ITERATIONS) {
			loopIteration++;
			const lastSeqRow = await this.#db.get_last_turn_sequence.get({
				run_id: currentRunId,
			});
			currentTurnSequence =
				lastSeqRow && lastSeqRow.last_seq !== null
					? lastSeqRow.last_seq + 1
					: 0;

			// Fetch history from SQL (Authoritative)
			const historyRows = await this.#db.get_turn_history.all({
				run_id: currentRunId,
			});
			const historyMessages = [];
			for (const row of historyRows) {
				if (!row.turn_id) continue;
				const turn = new Turn(this.#db, row.turn_id);
				await turn.hydrate();
				const msgs = await turn.serialize();
				historyMessages.push(...msgs);
			}

			// Peek at last turn state
			let hasUnknowns = true;
			let tasksComplete = false;
			const lastTurnRow = historyRows.at(-1);
			if (lastTurnRow) {
				const lastTurn = new Turn(this.#db, lastTurnRow.turn_id);
				await lastTurn.hydrate();
				const lastJson = lastTurn.toJson();
				const unknownText = (lastJson.assistant.unknown || "").trim();
				hasUnknowns =
					unknownText.length > 0 &&
					!/^<unknown\s*\/>$/i.test(unknownText) &&
					!/^<unknown\s*>\s*<\/unknown\s*>$/i.test(unknownText);
				tasksComplete =
					lastJson.assistant.tasks.length > 0 &&
					lastJson.assistant.tasks.every((t) => t.completed);
			}

			// Create fresh Turn entry in DB
			const turnRow = await this.#db.create_empty_turn.get({
				run_id: String(currentRunId || ""),
				sequence: Number(currentTurnSequence),
			});
			const turnId = turnRow.id;

			// Build initial prompt tags and COMMIT to SQL
			const turnObj = await this.#turnBuilder.build({
				type,
				project,
				sessionId,
				model: requestedModel,
				db: this.#db,
				prompt: loopPrompt,
				sequence: Number(currentTurnSequence),
				hasUnknowns,
				tasksComplete,
				turnId,
				runId: currentRunId,
			});

			const currentTurnMessages = await turnObj.serialize();
			const newUserMsg = currentTurnMessages.find((m) => m.role === "user");
			const filteredMessages = await this.#hooks.llm.messages.filter(
				[
					...currentTurnMessages.filter((m) => m.role === "system"),
					...historyMessages,
					newUserMsg,
				].filter(Boolean),
				{ model: requestedModel, sessionId, runId: currentRunId },
			);

			const prefill = "<tasks>\n- [";
			const result = await this.#llmProvider.completion(
				[...filteredMessages, { role: "assistant", content: prefill }],
				requestedModel,
				{ temperature: options?.temperature },
			);
			const responseMessage = result.choices?.[0]?.message;
			const rawReasoning = responseMessage?.reasoning_content;
			const mergedContent = this.#responseParser.mergePrefill(
				prefill,
				responseMessage?.content || "",
			);

			const finalResponse = await this.#hooks.llm.response.filter(
				{
					...responseMessage,
					content: mergedContent,
					reasoning_content: rawReasoning,
				},
				{ model: requestedModel, sessionId, runId: currentRunId },
			);

			// Commit Usage Stats
			const usage = result.usage || {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
			};
			await this.#db.update_turn_stats.run({
				id: turnId,
				prompt_tokens: Number(usage.prompt_tokens || 0),
				completion_tokens: Number(usage.completion_tokens || 0),
				total_tokens: Number(usage.total_tokens || 0),
				cost: Number(usage.cost || 0),
			});

			// COMMIT ASSISTANT RESPONSE TO SQL
			const elements = await this.#db.get_turn_elements.all({
				turn_id: turnId,
			});
			const assistantNode = elements.find((el) => el.tag_name === "assistant");

			if (!assistantNode) {
				throw new Error(
					`Critical Error: assistant node not found in database for turn ${turnId}`,
				);
			}

			const commitAssistantTag = async (
				tagName,
				content,
				attrs = {},
				sequence = 0,
			) => {
				await this.#db.insert_turn_element.run({
					turn_id: turnId,
					parent_id: assistantNode.id,
					tag_name: String(tagName || ""),
					content: content === null ? null : String(content),
					attributes:
						typeof attrs === "string" ? attrs : JSON.stringify(attrs || {}),
					sequence: Number(sequence),
				});
			};

			if (finalResponse.reasoning_content) {
				await commitAssistantTag(
					"reasoning_content",
					finalResponse.reasoning_content,
					{},
					0,
				);
			}
			await commitAssistantTag("content", finalResponse.content, {}, 1);
			await commitAssistantTag(
				"meta",
				JSON.stringify({
					prompt_tokens: usage.prompt_tokens,
					completion_tokens: usage.completion_tokens,
					total_tokens: usage.total_tokens,
					alias: requestedModel,
					actualModel: result.model,
					displayModel: this.#resolveAlias(requestedModel),
				}),
				{},
				2,
			);

			const tags = this.#responseParser.parseActionTags(finalResponse.content);
			for (let i = 0; i < tags.length; i++) {
				const tag = tags[i];
				if (["tasks", "known", "unknown", "summary"].includes(tag.tagName)) {
					await commitAssistantTag(
						tag.tagName,
						this.#responseParser.getNodeText(tag),
						{},
						i + 3,
					);
				}
			}

			// HYDRATE AND VALIDATE
			await turnObj.hydrate();

			// PROTOCOL VALIDATION
			const validationErrors = [];
			if (protocolRetries < MAX_PROTOCOL_RETRIES) {
				const constraints = await this.#db.get_protocol_constraints.get({
					type,
					has_unknowns: hasUnknowns ? 1 : 0,
				});
				if (constraints) {
					const required = constraints.required_tags
						.split(/\s+/)
						.filter(Boolean);
					const allowed = constraints.allowed_tags.split(/\s+/).filter(Boolean);
					const presentTags = new Set(tags.map((t) => t.tagName));

					for (const req of required) {
						if (!presentTags.has(req)) {
							validationErrors.push({
								content: `Missing required tag: <${req}>`,
								attrs: { protocol: "violation" },
							});
						}
					}
					for (const tag of tags) {
						if (tag.tagName === "summary") continue;
						if (!allowed.includes(tag.tagName)) {
							validationErrors.push({
								content: `Disallowed tag used: <${tag.tagName}>`,
								attrs: { protocol: "violation" },
							});
						}
					}
					const turnJson = turnObj.toJson();
					const hasUnknownsNow =
						turnJson.assistant.unknown &&
						turnJson.assistant.unknown.trim().length > 0 &&
						!/^<unknown\s*\/>$/i.test(turnJson.assistant.unknown) &&
						!/^<unknown\s*>\s*<\/unknown\s*>$/i.test(
							turnJson.assistant.unknown,
						);

					if (!hasUnknownsNow && !presentTags.has("summary")) {
						const contextNode2 = elements.find((el) => el.tag_name === "context");
						if (contextNode2) {
							await this.#db.insert_turn_element.run({
								turn_id: turnId,
								parent_id: contextNode2.id,
								tag_name: "warn",
								content: "No unknowns but no <summary> provided.",
								attributes: JSON.stringify({ protocol: "warning" }),
								sequence: 150,
							});
						}
					}
				}
			}

			if (validationErrors.length > 0) {
				protocolRetries++;
				const contextNode = elements.find((el) => el.tag_name === "context");
				if (contextNode) {
					for (let j = 0; j < validationErrors.length; j++) {
						const err = validationErrors[j];
						await this.#db.insert_turn_element.run({
							turn_id: turnId,
							parent_id: contextNode.id,
							tag_name: "error",
							content: String(err.content || ""),
							attributes: JSON.stringify(err.attrs || {}),
							sequence: 100 + j,
						});
					}
				}
				await turnObj.hydrate();
				await this.#hooks.run.step.completed.emit({
					runId: currentRunId,
					sessionId,
					turn: turnObj,
					projectFiles: await this.#sessionManager.getFiles(project.path),
				});
				continue;
			}

			// Process Findings
			const atomicResult = {
				runId: currentRunId,
				sequence: Number(currentTurnSequence),
				content: finalResponse.content,
				reasoning: finalResponse.reasoning_content,
				usage,
				diffs: [],
				commands: [],
				notifications: [],
			};
			await this.#findingsManager.populateFindings(
				project.path,
				atomicResult,
				tags,
			);

			// PERSIST FINDINGS TO DB
			for (const diff of atomicResult.diffs) {
				await this.#db.insert_finding_diff.run({
					run_id: currentRunId,
					turn_id: turnId,
					type: diff.type,
					file_path: diff.file,
					patch: diff.patch,
				});
			}
			for (const cmd of atomicResult.commands) {
				await this.#db.insert_finding_command.run({
					run_id: currentRunId,
					turn_id: turnId,
					type: cmd.type,
					command: cmd.command,
				});
			}
			for (const notif of atomicResult.notifications) {
				await this.#db.insert_finding_notification.run({
					run_id: currentRunId,
					turn_id: turnId,
					type: notif.type,
					text: notif.text,
					level: notif.level || "info",
					status: notif.type === "prompt_user" ? "proposed" : "acknowledged",
					config: notif.config ? JSON.stringify(notif.config) : null,
					append: notif.append ? 1 : 0,
				});
			}

			// Update attention tracking
			const mentions = new Set();
			const wordRegex = /[a-zA-Z0-9_./-]+/g;
			const turnJson = turnObj.toJson();
			for (const match of `${turnJson.assistant.content} ${turnJson.assistant.reasoning_content} ${turnJson.assistant.known}`.matchAll(
				wordRegex,
			)) {
				mentions.add(match[0]);
			}
			for (const mention of mentions) {
				try {
					await this.#db.update_file_attention.run({
						project_id: String(projectId),
						run_id: currentRunId,
						turn_seq: Number(currentTurnSequence),
						mention: String(mention),
					});
				} catch (_err) {}
			}

			// <read> tags: handled by FindingsManager (agent promotion).
			// File appears in context on the next turn via renderPerspective.
			const readTags = tags.filter((t) => t.tagName === "read");

			// FINAL HYDRATE BEFORE EMISSION
			await turnObj.hydrate();

			// Finalize Turn EMISSION
			await this.#hooks.run.step.completed.emit({
				runId: currentRunId,
				sessionId,
				turn: turnObj,
				projectFiles: await this.#sessionManager.getFiles(project.path),
			});

			const isChecklistComplete =
				turnJson.assistant.tasks.length > 0 &&
				turnJson.assistant.tasks.every((t) => t.completed);
			const summaryTag = tags.find((t) => t.tagName === "summary");

			// Breaking tags: anything that requires client resolution before continuing
			const breakingTags = tags.filter((t) =>
				["create", "delete", "edit", "run", "env", "prompt_user"].includes(
					t.tagName,
				),
			);

			if (breakingTags.length > 0) {
				await this.#db.update_run_status.run({
					id: currentRunId,
					status: "proposed",
				});
				const proposed = await this.#db.get_unresolved_findings.all({
					run_id: currentRunId,
				});
				return {
					runId: currentRunId,
					status: "proposed",
					turn: currentTurnSequence,
					proposed,
				};
			}

			// <read> tags force continuation — the model requested file content
			// it hasn't seen yet. Next turn renders it via renderPerspective.
			if (readTags.length > 0) {
				continue;
			}

			const hasNoUnknowns =
				!turnJson.assistant.unknown ||
				turnJson.assistant.unknown.trim().length === 0;

			if (isChecklistComplete || summaryTag || hasNoUnknowns) {
				await this.#db.update_run_status.run({
					id: currentRunId,
					status: "completed",
				});
				return {
					runId: currentRunId,
					status: "completed",
					turn: currentTurnSequence,
				};
			}

			break;
		}

		return {
			runId: currentRunId,
			status: "running",
			turn: currentTurnSequence,
		};
	}

	async resolve(runId, resolution) {
		const run = await this.#db.get_run_by_id.get({ id: runId });
		if (!run) throw new Error(`Run '${runId}' not found.`);

		const { category, id, action } = resolution;

		// Update finding status in DB
		if (category === "diff") {
			await this.#db.update_finding_diff_status.run({ id, status: action });
			const finding = await this.#db.get_findings_by_run_id.all({ run_id: runId });
			const diff = finding.find((f) => f.category === "diff" && f.id === id);
			const filePath = diff?.file || "unknown";
			const tag = action === "accepted" ? "info" : "warn";
			const label = action === "modified" ? "edits partially accepted" : `edits ${action}`;
			await this.#db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: diff?.turn_id || 0,
				type: "diff",
				request: filePath,
				result: label,
				is_error: 0,
			});
		} else if (category === "command") {
			await this.#db.update_finding_command_status.run({ id, status: action });
			const finding = await this.#db.get_findings_by_run_id.all({ run_id: runId });
			const cmd = finding.find((f) => f.category === "command" && f.id === id);
			const command = cmd?.patch || "unknown";
			await this.#db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: cmd?.turn_id || 0,
				type: "command",
				request: command,
				result: resolution.output || action,
				is_error: resolution.isError ? 1 : 0,
			});
		} else if (category === "notification") {
			await this.#db.update_finding_notification_status.run({
				id,
				status: "responded",
			});
			const finding = await this.#db.get_findings_by_run_id.all({ run_id: runId });
			const notif = finding.find((f) => f.category === "notification" && f.id === id);
			await this.#db.insert_pending_context.run({
				run_id: runId,
				source_turn_id: notif?.turn_id || 0,
				type: "notification",
				request: notif?.patch || "prompt_user",
				result: resolution.answer || action,
				is_error: 0,
			});
		}

		// Check remaining proposed findings
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

		// All findings resolved — auto-resume the run
		return this.run(run.type, run.session_id, null, "", null, runId);
	}

	async getRunHistory(runId) {
		const historyRows = await this.#db.get_turn_history.all({ run_id: runId });
		return historyRows.map((r) => ({ role: r.role, content: r.content }));
	}
}
