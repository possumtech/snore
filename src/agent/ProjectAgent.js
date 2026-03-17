import crypto from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import * as parse5 from "parse5";
import createHooks from "../core/Hooks.js";
import OpenRouterClient from "../core/OpenRouterClient.js";
import ProjectContext from "../core/ProjectContext.js";
import TurnBuilder from "../core/TurnBuilder.js";
import HeuristicMatcher from "../core/HeuristicMatcher.js";

export default class ProjectAgent {
	#db;
	#client;
	#hooks;
	#turnBuilder;

	constructor(db, hooks = createHooks()) {
		this.#db = db;
		this.#hooks = hooks;
		this.#client = new OpenRouterClient(process.env.OPENROUTER_API_KEY, hooks);
		this.#turnBuilder = new TurnBuilder(hooks);
	}

	async #getVisibilityMap(projectId) {
		const files = await this.#db.get_project_repo_map.all({
			project_id: projectId,
		});
		const map = new Map();
		for (const f of files) {
			map.set(f.path, f.visibility);
		}
		return map;
	}

	async init(projectPath, projectName, clientId) {
		await this.#hooks.project.init.started.emit({
			projectPath,
			projectName,
			clientId,
		});

		const actualProjectId = crypto.randomUUID();
		const sessionId = crypto.randomUUID();

		await this.#db.upsert_project.run({
			id: actualProjectId,
			path: projectPath,
			name: projectName,
		});

		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		const projectId = projects[0].id;

		await this.#db.create_session.run({
			id: sessionId,
			project_id: projectId,
			client_id: clientId,
		});

		// Discover project context
		const { default: GitProvider } = await import("../core/GitProvider.js");
		const gitRoot = await GitProvider.detectRoot(projectPath);
		const headHash = gitRoot ? await GitProvider.getHeadHash(gitRoot) : null;

		const result = {
			projectId,
			sessionId,
			context: {
				gitRoot,
				headHash,
			},
		};

		await this.#hooks.project.init.completed.emit({
			...result,
			projectPath,
			db: this.#db,
		});
		return result;
	}

	async getFiles(projectPath) {
		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		const visibilityMap = await this.#getVisibilityMap(projects[0].id);
		const ctx = await ProjectContext.open(projectPath, visibilityMap);
		const mappable = await ctx.getMappableFiles();
		const results = [];
		for (const relPath of mappable) {
			results.push({ path: relPath, state: await ctx.resolveState(relPath) });
		}
		return results;
	}

	async updateFiles(projectId, files) {
		await this.#hooks.project.files.update.started.emit({ projectId, files });

		for (const f of files) {
			await this.#db.upsert_repo_map_file.run({
				project_id: projectId,
				path: f.path,
				visibility: f.visibility,
				hash: null,
				size: 0,
			});
		}

		const project = await this.#db.get_project_by_id.get({ id: projectId });
		await this.#hooks.project.files.update.completed.emit({
			projectId,
			projectPath: project.path,
			files,
			db: this.#db,
		});

		return { status: "ok" };
	}

	async startRun(sessionId, runConfig) {
		const runId = crypto.randomUUID();

		const config = await this.#hooks.run.config.filter(runConfig, {
			sessionId,
		});

		await this.#db.create_run.run({
			id: runId,
			session_id: sessionId,
			parent_run_id: config.parentRunId || null,
			type: config.type,
			config: JSON.stringify(config.config || {}),
		});

		await this.#hooks.run.started.emit({
			runId,
			sessionId,
			type: config.type,
		});
		return runId;
	}

	async setSystemPrompt(sessionId, systemPrompt) {
		await this.#db.update_session_system_prompt.run({ id: sessionId, system_prompt: systemPrompt });
	}

	async setPersona(sessionId, persona) {
		await this.#db.update_session_persona.run({ id: sessionId, persona });
	}

	async addSkill(sessionId, name) {
		await this.#db.insert_session_skill.run({ session_id: sessionId, name });
	}

	async removeSkill(sessionId, name) {
		await this.#db.delete_session_skill.run({ session_id: sessionId, name });
	}

	async #applyDiff(projectPath, diff) {
		const fullPath = join(projectPath, diff.file);
		if (diff.type === "delete") {
			await fs.unlink(fullPath).catch(() => {});
		} else if (diff.type === "create" || diff.type === "edit") {
			// For edit, we assume the patch was already matched/applied to content in memory
			// or if it's a raw content create.
			// However, in our system, 'patch' field for 'edit' after HeuristicMatcher 
			// contains the full NEW content of the file (or we should make it so).
			// Wait, HeuristicMatcher.matchAndPatch returns a Unified Diff string.
			// We need a way to apply that diff physically.
			// Let's assume for now the model provides full content for create, 
			// and we'll add a 'patch' utility for edit.
			if (diff.type === "create") {
				await fs.writeFile(fullPath, diff.patch, "utf8");
			} else {
				// Applying a Unified Diff physically
				const { applyPatch } = await import("diff");
				const oldContent = await fs.readFile(fullPath, "utf8");
				const newContent = applyPatch(oldContent, diff.patch);
				if (newContent) {
					await fs.writeFile(fullPath, newContent, "utf8");
				} else {
					throw new Error(`Failed to apply patch to ${diff.file}`);
				}
			}
		}
	}

	async #resolveOutstandingFindings(projectPath, runId, prompt) {
		const findings = await this.#db.get_findings_by_run_id.all({ run_id: runId });
		const proposed = findings.filter((f) => f.status === "proposed");
		if (proposed.length === 0) return { resolvedCount: 0, remainingCount: 0 };

		// Parse resolution tags: <info diff="ID">Accepted</info>
		const frag = parse5.parseFragment(prompt);
		const infoTags = [];
		const traverse = (node) => {
			if (node.tagName === "info") infoTags.push(node);
			if (node.childNodes) {
				for (const child of node.childNodes) traverse(child);
			}
		};
		traverse(frag);

		let resolvedCount = 0;
		for (const tag of infoTags) {
			const diffId = tag.attrs.find((a) => a.name === "diff")?.value;
			const cmdId = tag.attrs.find((a) => a.name === "command")?.value;
			const resolution = this.#getNodeText(tag).trim();

			if (diffId) {
				const finding = proposed.find((f) => f.category === "diff" && String(f.id) === diffId);
				if (finding) {
					const status = resolution.toLowerCase() === "accepted" ? "accepted" : "rejected";
					if (status === "accepted") {
						await this.#applyDiff(projectPath, finding);
					}
					await this.#db.update_finding_diff_status.run({ id: finding.id, status });
					resolvedCount++;
				}
			} else if (cmdId) {
				const finding = proposed.find((f) => f.category === "command" && String(f.id) === cmdId);
				if (finding) {
					const status = resolution.toLowerCase() === "accepted" ? "accepted" : "rejected";
					await this.#db.update_finding_command_status.run({ id: finding.id, status });
					resolvedCount++;
				}
			}
		}

		const remainingCount = proposed.length - resolvedCount;
		return { resolvedCount, remainingCount };
	}

	async ask(sessionId, model, prompt, activeFiles = [], runId = null) {
		return this.#executeRun(
			"ask",
			sessionId,
			model,
			prompt,
			activeFiles,
			runId,
		);
	}

	async act(sessionId, model, prompt, activeFiles = [], runId = null) {
		return this.#executeRun(
			"act",
			sessionId,
			model,
			prompt,
			activeFiles,
			runId,
		);
	}

	#getNodeText(node) {
		const html = parse5.serialize(node);
		return html
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&")
			.replace(/&quot;/g, '"');
	}

	#parseActionTags(content) {
		const frag = parse5.parseFragment(content);
		const tags = [];
		const traverse = (node) => {
			if (
				node.tagName &&
				[
					"read",
					"env",
					"run",
					"create",
					"delete",
					"edit",
					"prompt_user",
					"summary",
					"tasks",
				].includes(node.tagName)
			) {
				tags.push(node);
			}
			if (node.childNodes) {
				for (const child of node.childNodes) {
					traverse(child);
				}
			}
		};
		traverse(frag);
		return tags;
	}

	async #populateFindings(projectPath, atomicResult, tags) {
		for (const tag of tags) {
			if (tag.tagName === "edit" || tag.tagName === "create" || tag.tagName === "delete") {
				const file = tag.attrs.find((a) => a.name === "file")?.value;
				if (file) {
					let patchContent = this.#getNodeText(tag).trim();

					if (tag.tagName === "edit") {
						try {
							const fullPath = join(projectPath, file);
							const fileContent = await fs.readFile(fullPath, "utf8");
							const searchMatch = patchContent.match(/<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n/);
							const replaceMatch = patchContent.match(/=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/);
							
							if (searchMatch && replaceMatch) {
								const searchBlock = searchMatch[1];
								const replaceBlock = replaceMatch[1];
								const matchResult = HeuristicMatcher.matchAndPatch(file, fileContent, searchBlock, replaceBlock);
								
								if (matchResult.error) {
									atomicResult.notifications.push({
										type: "notify",
										text: `Error applying edit to ${file}: ${matchResult.error}`,
										level: "error",
									});
								} else {
									if (matchResult.warning) {
										atomicResult.notifications.push({
											type: "notify",
											text: `Warning for ${file}: ${matchResult.warning}`,
											level: "warn",
										});
									}
									patchContent = matchResult.patch;
								}
							}
						} catch (err) {
							// File read error or parsing error
							atomicResult.notifications.push({
								type: "notify",
								text: `Failed to read or parse file ${file} for editing: ${err.message}`,
								level: "error",
							});
						}
					}

					atomicResult.diffs.push({
						runId: atomicResult.runId,
						type: tag.tagName,
						file,
						patch: patchContent,
					});
				}
			} else if (tag.tagName === "env" || tag.tagName === "run") {
				atomicResult.commands.push({
					type: tag.tagName,
					command: this.#getNodeText(tag).trim(),
				});
			} else if (tag.tagName === "prompt_user" || tag.tagName === "summary") {
				atomicResult.notifications.push({
					type: tag.tagName,
					text: this.#getNodeText(tag).trim(),
				});
			}
		}

		// Keep legacy test markers for our E2E tests for now
		const turnContent = atomicResult.content;
		if (turnContent.includes("RUMMY_TEST_DIFF")) {
			atomicResult.diffs.push({
				runId: atomicResult.runId,
				type: "edit",
				file: "test.txt",
				patch: "--- test.txt\n+++ test.txt\n@@ -1 +1 @@\n-old\n+new",
			});
		}
		if (turnContent.includes("RUMMY_TEST_NOTIFY")) {
			atomicResult.notifications.push({
				type: "notify",
				text: "System notification detected in response",
				level: "info",
			});
		}
		if (turnContent.includes("RUMMY_TEST_RENDER")) {
			atomicResult.notifications.push({
				type: "render",
				text: "# Rendered Content",
				append: false,
			});
		}
	}

	#resolveAlias(modelId) {
		if (!modelId) return modelId;
		// Check if the input is already an alias
		if (process.env[`RUMMY_MODEL_${modelId}`]) return modelId;

		// Check if the input is a target of an existing alias
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("RUMMY_MODEL_") && process.env[key] === modelId) {
				return key.replace("RUMMY_MODEL_", "");
			}
		}
		return modelId;
	}

	async #executeRun(
		type,
		sessionId,
		model,
		prompt,
		activeFiles = [],
		runId = null,
	) {
		const hook = type === "ask" ? this.#hooks.ask : this.#hooks.act;
		await hook.started.emit({
			sessionId,
			model,
			prompt,
			activeFiles,
			runId,
		});

		const sessions = await this.#db.get_session_by_id.all({ id: sessionId });
		const project = await this.#db.get_project_by_id.get({
			id: sessions[0].project_id,
		});

		let currentRunId = runId;
		let sequenceOffset = 0;
		const historyMessages = [];

		if (currentRunId) {
			const existingRun = await this.#db.get_run_by_id.get({
				id: currentRunId,
			});
			if (!existingRun || existingRun.session_id !== sessionId) {
				throw new Error(`Run '${currentRunId}' not found in this session.`);
			}
			const previousTurns = await this.#db.get_turns_by_run_id.all({
				run_id: currentRunId,
			});

			// Declarative Resolution Gate
			const { resolvedCount, remainingCount } = await this.#resolveOutstandingFindings(project.path, currentRunId, prompt);
			if (remainingCount > 0) {
				// If still blocked, return current state immediately
				const lastTurn = previousTurns[previousTurns.length - 1];
				const payload = JSON.parse(lastTurn.payload);
				
				// Re-fetch findings to bundle the unresolved ones
				const findings = await this.#db.get_findings_by_run_id.all({ run_id: currentRunId });
				const proposed = findings.filter(f => f.status === 'proposed');

				return {
					runId: currentRunId,
					content: `Blocked: ${remainingCount} proposed action(s) still require resolution.`,
					status: 'proposed',
					diffs: proposed.filter(f => f.category === 'diff').map(f => ({
						id: f.id,
						runId: currentRunId,
						type: f.type,
						file: f.file,
						patch: f.patch,
						status: f.status
					})),
					commands: proposed.filter(f => f.category === 'command').map(f => ({
						id: f.id,
						type: f.type,
						command: f.patch,
						status: f.status
					})),
					notifications: [{
						type: 'notify',
						text: `${remainingCount} action(s) still pending resolution.`,
						level: 'warn'
					}]
				};
			}

			// All resolved! Transition back to running.
			await this.#db.update_run_status.run({ id: currentRunId, status: 'running' });

			// History logic:
			// Reconstruct history...
			for (const turn of previousTurns) {
				const payload = JSON.parse(turn.payload);
				if (Array.isArray(payload)) {
					// It's a request Turn (System + User or just User)
					// We only want the User messages from history if they aren't the first one (which had system)
					// Actually, simpler: Just take the User/Assistant messages.
					const userMsgs = payload.filter((m) => m.role === "user");
					historyMessages.push(...userMsgs);
				} else if (payload.role === "assistant") {
					historyMessages.push(payload);
				}
				sequenceOffset = Math.max(sequenceOffset, turn.sequence_number + 1);
			}
		} else {
			currentRunId = crypto.randomUUID();
			await this.#db.create_run.run({
				id: currentRunId,
				session_id: sessionId,
				type,
				config: JSON.stringify({ model, activeFiles }),
			});
		}

		let currentActiveFiles = [...(activeFiles || [])];
		let loopPrompt = prompt;
		let finalResult = null;

		while (true) {
			const turnObj = await this.#turnBuilder.build({
				type,
				project,
				sessionId,
				prompt: loopPrompt,
				model,
				activeFiles: currentActiveFiles,
				db: this.#db,
			});

			const currentTurnMessages = await turnObj.serialize();

			// Construct final message set:
			// [New System/Context] + [History User/Assistant] + [New User Prompt]
			const systemMsgs = currentTurnMessages.filter((m) => m.role === "system");
			const newUserMsg = currentTurnMessages.find((m) => m.role === "user");

			const finalMessages = [
				...systemMsgs,
				...historyMessages,
				newUserMsg,
			].filter(Boolean);

			const filteredMessages = await this.#hooks.llm.messages.filter(
				finalMessages,
				{
					model,
					sessionId,
					runId: currentRunId,
				},
			);

			const _initialTurn = await this.#db.create_turn.run({
				run_id: currentRunId,
				sequence_number: sequenceOffset,
				payload: JSON.stringify(filteredMessages),
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
				cost: 0,
			});

			const requestedModel = model || process.env.RUMMY_MODEL_DEFAULT;
			if (!requestedModel) {
				throw new Error("No model specified and RUMMY_MODEL_DEFAULT is not set.");
			}

			const targetModel =
				process.env[`RUMMY_MODEL_${requestedModel}`] || requestedModel;

			if (process.env.RUMMY_DEBUG === "true") {
				console.log(
					`[LLM] Target Model: ${targetModel} (requested: ${requestedModel})`,
				);
			}

			await this.#hooks.llm.request.started.emit({
				runId: currentRunId,
				model: targetModel,
				messages: filteredMessages,
			});
			const result = await this.#client.completion(
				filteredMessages,
				targetModel,
			);
			await this.#hooks.llm.request.completed.emit({
				runId: currentRunId,
				result,
			});

			const responseMessage = result.choices?.[0]?.message;

			const finalResponse = await this.#hooks.llm.response.filter(
				responseMessage,
				{ model, sessionId, runId: currentRunId },
			);

			const usage = result.usage || {
				prompt_tokens: 0,
				completion_tokens: 0,
				total_tokens: 0,
				cost: 0,
			};

			const completedTurn = await this.#db.create_turn.run({
				run_id: currentRunId,
				sequence_number: sequenceOffset + 1,
				payload: JSON.stringify(finalResponse),
				prompt_tokens: usage.prompt_tokens || 0,
				completion_tokens: usage.completion_tokens || 0,
				total_tokens: usage.total_tokens || 0,
				cost: usage.cost || 0,
			});
			const turnId = completedTurn.lastInsertRowid;

			if (finalResponse?.reasoning_content) {
				turnObj.assistant.reasoning.add(finalResponse.reasoning_content);
			}
			if (finalResponse?.content) {
				turnObj.assistant.content.add(finalResponse.content);
			}
			turnObj.assistant.meta.add({
				...usage,
				alias: requestedModel,
				actualModel: result.model,
				displayModel: this.#resolveAlias(requestedModel),
			});

			// Build the clean RUMMY result object
			const atomicResult = {
				runId: currentRunId,
				model: {
					requested: model || process.env.RUMMY_MODEL_DEFAULT,
					alias: this.#resolveAlias(requestedModel),
					target: targetModel,
					actual: result.model,
					display: this.#resolveAlias(requestedModel),
				},
				content: finalResponse?.content || "",
				reasoning: finalResponse?.reasoning_content || null,
				finishReason: result.choices?.[0]?.finish_reason || "stop",
				usage: {
					promptTokens: usage.prompt_tokens || 0,
					completionTokens: usage.completion_tokens || 0,
					totalTokens: usage.total_tokens || 0,
					cost: usage.cost || 0,
				},
				activeFiles: currentActiveFiles,
				diffs: [],
				commands: [],
				notifications: [],
				openaiRaw: result,
			};

			// Run the core findings engine
			const turnContent =
				turnObj.doc.getElementsByTagName("content")[0]?.textContent;
			
			const tags = this.#parseActionTags(turnContent || "");
			await this.#populateFindings(project.path, atomicResult, tags);

			// Emit progress notification if tasks are present
			const tasksTag = tags.find((t) => t.tagName === "tasks");
			if (tasksTag) {
				await this.#hooks.run.progress.emit({
					runId: currentRunId,
					sessionId,
					tasks: this.#getNodeText(tasksTag).trim(),
					status: "Agent is thinking...",
				});
			}

			// Check for breaking tags
			const readTags = tags.filter((t) => t.tagName === "read");
			const breakingTags = tags.filter((t) =>
				["env", "run", "create", "delete", "edit", "prompt_user", "summary"].includes(
					t.tagName,
				),
			);

			// If we have breaking tags, or NO tags at all, we break the loop and return.
			if (breakingTags.length > 0 || (readTags.length === 0 && breakingTags.length === 0)) {
				const finalStatus = type === "act" ? "proposed" : "completed";
				await this.#db.update_run_status.run({
					id: currentRunId,
					status: finalStatus,
				});

				// Persist Findings to Database
				for (const diff of atomicResult.diffs) {
					await this.#db.insert_finding_diff.run({
						run_id: currentRunId,
						turn_id: turnId,
						type: diff.type,
						file_path: diff.file,
						patch: diff.patch,
					});
				}
				for (const notif of atomicResult.notifications) {
					await this.#db.insert_finding_notification.run({
						run_id: currentRunId,
						turn_id: turnId,
						type: notif.type,
						text: notif.text,
						level: notif.level || null,
						append: notif.append !== undefined ? (notif.append ? 1 : 0) : null,
					});
				}

				finalResult = await this.#hooks.run.turn.filter(atomicResult, {
					turn: turnObj,
					sessionId,
					type,
				});

				await hook.completed.emit({
					runId: currentRunId,
					sessionId,
					model: targetModel,
					turn: turnObj,
					usage,
					result: finalResult,
				});

				break; // Exit the while(true) loop
			} else {
				// ONLY <read> tags found
				const newFiles = readTags
					.map((t) => t.attrs.find((a) => a.name === "file")?.value)
					.filter(Boolean);
				
				currentActiveFiles = [...new Set([...currentActiveFiles, ...newFiles])];
				
				historyMessages.push(newUserMsg);
				historyMessages.push(finalResponse);
				
				sequenceOffset += 2;
				loopPrompt = `<info>Read ${newFiles.length} file(s): ${newFiles.join(", ")}. Content is now available in the system context.</info>`;
			}
		}

		return finalResult;
	}
}
