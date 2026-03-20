import { exec } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * AgentLoop: Coordinates the autonomous Rumsfeld Loop.
 * The Loop Arbiter enforces Hierarchical Priority: Gather > Action > Summary.
 */
export default class AgentLoop {
	#db;
	#llmProvider;
	#hooks;
	#turnBuilder;
	#responseParser;
	#findingsManager;

	constructor(
		db,
		llmProvider,
		hooks,
		turnBuilder,
		responseParser,
		findingsManager,
	) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#turnBuilder = turnBuilder;
		this.#responseParser = responseParser;
		this.#findingsManager = findingsManager;
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

	async run(type, sessionId, model, prompt, projectBufferFiles = null, runId = null) {
		const hook = type === "ask" ? this.#hooks.ask : this.#hooks.act;
		await hook.started.emit({ sessionId, model, prompt, projectBufferFiles, runId });

		const sessions = await this.#db.get_session_by_id.all({
			id: String(sessionId),
		});
		const projectId = String(sessions[0].project_id);
		const project = await this.#db.get_project_by_id.get({
			id: projectId,
		});

		// 1. INITIAL SYNC: Buffered Files
		if (Array.isArray(projectBufferFiles)) {
			await this.#db.reset_buffered.run({ project_id: projectId });
			for (const path of projectBufferFiles) {
				await this.#db.set_buffered.run({ project_id: projectId, path });
			}
		}

		let currentRunId = runId;
		let yolo = false;

		if (currentRunId) {
			const existingRun = await this.#db.get_run_by_id.get({ id: currentRunId });
			if (!existingRun) throw new Error(`Run '${currentRunId}' not found.`);
			yolo = JSON.parse(existingRun.config || "{}").yolo === true;

			if (yolo) {
				const proposed = await this.#db.get_unresolved_findings.all({ run_id: currentRunId });
				for (const f of proposed) {
					if (f.category === "diff") await this.#findingsManager.applyDiff(project.path, f);
					await (f.category === "diff"
						? this.#db.update_finding_diff_status.run({ id: f.id, status: "accepted" })
						: this.#db.update_finding_command_status.run({ id: f.id, status: "accepted" }));
				}
			}

			const infoTags = this.#responseParser.parseActionTags(prompt).filter((t) => t.tagName === "info");
			await this.#findingsManager.resolveOutstandingFindings(project.path, currentRunId, prompt, infoTags);

			const remaining = await this.#db.get_unresolved_findings.all({ run_id: currentRunId });
			if (remaining.length > 0 && !yolo) {
				return { runId: currentRunId, status: "proposed", remainingCount: remaining.length, proposed: remaining };
			}

			await this.#db.update_run_status.run({ id: currentRunId, status: "running" });
		} else {
			currentRunId = crypto.randomUUID();
			yolo = prompt.includes("RUMMY_YOLO") || (projectBufferFiles && projectBufferFiles.yolo === true);
			await this.#db.create_run.run({
				id: currentRunId,
				session_id: sessionId,
				type,
				config: JSON.stringify({ model, yolo }),
			});
		}

		let loopPrompt = prompt;
		const requestedModel = model || process.env.RUMMY_MODEL_DEFAULT;
		let currentTurnSequence = 0;

		// --- THE ATOMIC TURN LOOP ---
		while (true) {
			const lastSeqRow = await this.#db.get_last_turn_sequence.get({ run_id: currentRunId });
			const sequenceOffset = lastSeqRow.last_seq !== null ? lastSeqRow.last_seq + 1 : 0;
			currentTurnSequence = sequenceOffset;

			const historyRows = await this.#db.get_turn_history.all({ run_id: currentRunId });
			const historyMessages = historyRows.map(r => ({ role: r.role, content: r.content }));

			const lastAssistantMsg = historyMessages.filter(m => m.role === "assistant").at(-1);
			const previousTags = this.#responseParser.parseActionTags(lastAssistantMsg?.content || "");
			const unknownTag = previousTags.find(t => t.tagName === "unknown");
			const hasUnknowns = unknownTag ? this.#responseParser.getNodeText(unknownTag).trim().length > 0 : true;
			const tasksTagPrev = previousTags.find(t => t.tagName === "tasks");
			const tasksTextPrev = tasksTagPrev ? this.#responseParser.getNodeText(tasksTagPrev).trim() : "";
			const tasksComplete = tasksTextPrev.length > 0 && !tasksTextPrev.includes("- [ ]");

			const { id: turnId } = await this.#db.create_empty_turn.get({ run_id: currentRunId, sequence_number: sequenceOffset });

			const turnObj = await this.#turnBuilder.build({
				type, project, sessionId, model: requestedModel, db: this.#db,
				prompt: loopPrompt,
				sequence: sequenceOffset,
				hasUnknowns, tasksComplete, turnId
			});

			const currentTurnMessages = await turnObj.serialize();
			const newUserMsg = currentTurnMessages.find(m => m.role === "user");
			const filteredMessages = await this.#hooks.llm.messages.filter([
				...currentTurnMessages.filter(m => m.role === "system"),
				...historyMessages,
				newUserMsg
			].filter(Boolean), { model: requestedModel, sessionId, runId: currentRunId });

			const prefill = "<tasks>\n- [";
			const result = await this.#llmProvider.completion([...filteredMessages, { role: "assistant", content: prefill }], requestedModel);
			const responseMessage = result.choices?.[0]?.message;
			const mergedContent = this.#responseParser.mergePrefill(prefill, responseMessage?.content || "");
			
			const finalResponse = await this.#hooks.llm.response.filter({ ...responseMessage, content: mergedContent }, { model: requestedModel, sessionId, runId: currentRunId });
			const usage = result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };

			if (finalResponse?.reasoning_content) turnObj.assistant.reasoning.add(finalResponse.reasoning_content);
			if (finalResponse?.content) turnObj.assistant.content.add(finalResponse.content);
			turnObj.assistant.meta.add({ ...usage, alias: requestedModel, actualModel: result.model, displayModel: this.#resolveAlias(requestedModel) });

			await this.#db.update_turn_stats.run({ id: turnId, ...usage });
			await turnObj.save();

			const atomicResult = { runId: currentRunId, content: finalResponse?.content || "", reasoning: finalResponse?.reasoning_content || null, usage, diffs: [], commands: [], notifications: [], };
			const tags = this.#responseParser.parseActionTags(finalResponse.content);
			
			await this.#findingsManager.populateFindings(project.path, atomicResult, tags);

			const mentions = new Set();
			const wordRegex = /[a-zA-Z0-9_./-]+/g;
			const reasoningText = finalResponse.reasoning_content || "";
			const knownTag = tags.find(t => t.tagName === "known");
			const knownText = knownTag ? this.#responseParser.getNodeText(knownTag) : "";
			
			for (const match of (finalResponse.content + " " + reasoningText + " " + knownText).matchAll(wordRegex)) {
				mentions.add(match[0]);
			}
			for (const mention of mentions) {
				await this.#db.update_file_attention.run({ project_id: projectId, turn_seq: sequenceOffset, mention });
			}

			await this.#hooks.run.turn.audit.emit({ runId: currentRunId, turn: turnObj });
			await this.#hooks.run.step.completed.emit({ runId: currentRunId, sessionId, turn: turnObj });

			const tasksTag = tags.find(t => t.tagName === "tasks");
			const tasksText = tasksTag ? this.#responseParser.getNodeText(tasksTag).trim() : "";
			if (tasksText) await this.#hooks.run.progress.emit({ runId: currentRunId, sessionId, tasks: tasksText, status: "Agent is thinking..." });

			const gatherReadTags = tags.filter(t => t.tagName === "read");
			const gatherCmdTags = tags.filter(t => t.tagName === "env" || t.tagName === "run");
			const breakingTags = tags.filter(t => ["create", "delete", "edit", "prompt_user"].includes(t.tagName));
			const summaryTag = tags.find(t => t.tagName === "summary");
			const isChecklistComplete = tasksText.length > 0 && !tasksText.includes("- [ ]");

			if (gatherReadTags.length > 0 || gatherCmdTags.length > 0) {
				const infoTags = [];
				if (gatherReadTags.length > 0) {
					const paths = gatherReadTags.map(t => t.attrs.find(a => a.name === "file")?.value).filter(Boolean);
					for (const p of paths) infoTags.push(`<info file="${p}">Full file added to context</info>`);
				}
				for (const tag of gatherCmdTags) {
					const cmd = this.#responseParser.getNodeText(tag).trim();
					try {
						const { stdout, stderr } = await execAsync(cmd, { cwd: project.path });
						infoTags.push(`<info command="${cmd}">Executed ${tag.tagName}.\nOutput:\n${(stdout + stderr).trim() || "(no output)"}</info>`);
					} catch (err) {
						infoTags.push(`<info command="${cmd}">Failed to execute ${tag.tagName}.\nError: ${err.message}</info>`);
					}
				}
				loopPrompt = infoTags.join("\n");
				continue;
			}

			if (breakingTags.length > 0) {
				await this.#db.update_run_status.run({ id: currentRunId, status: "proposed" });
				for (const d of atomicResult.diffs) {
					await this.#db.insert_finding_diff.run({ run_id: currentRunId, turn_id: turnId, type: d.type, file_path: d.file, patch: d.patch });
				}
				for (const c of atomicResult.commands) {
					await this.#db.insert_finding_command.run({ run_id: currentRunId, turn_id: turnId, type: c.type, command: c.command });
				}
				for (const n of atomicResult.notifications) {
					if (n.type === "prompt_user") {
						await this.#db.insert_finding_notification.run({
							run_id: currentRunId, turn_id: turnId, type: n.type, text: n.text, level: "info", status: "proposed",
							config: JSON.stringify(n.config), append: n.append ? 1 : 0,
						});
					}
				}
				return { runId: currentRunId, status: "proposed", turn: currentTurnSequence };
			}

			if (isChecklistComplete || summaryTag || tags.find(t => t.tagName === "response")) {
				await this.#db.update_run_status.run({ id: currentRunId, status: "completed" });
				for (const n of atomicResult.notifications) {
					if (n.type === "summary" || n.type === "short") {
						await this.#db.insert_finding_notification.run({
							run_id: currentRunId, turn_id: turnId, type: n.type, text: n.text, level: "info", status: "acknowledged",
							config: null, append: n.append ? 1 : 0,
						});
					}
				}
				return { runId: currentRunId, status: "completed", turn: currentTurnSequence };
			}

			break;
		}

		return { runId: currentRunId, status: "running", turn: currentTurnSequence };
	}

	async resolve(runId, resolution) {
		const run = await this.#db.get_run_by_id.get({ id: runId });
		if (!run) throw new Error(`Run '${runId}' not found.`);
		const { category, id, action, answer } = resolution;
		const resumePrompt = category === "notification" ? `<info notification="${id}">${answer || action}</info>` : `<info ${category}="${id}">${action}</info>`;
		return this.run(run.type, run.session_id, null, resumePrompt, null, runId);
	}

	async getRunHistory(runId) {
		const historyRows = await this.#db.get_turn_history.all({ run_id: runId });
		return historyRows.map(r => ({ role: r.role, content: r.content }));
	}
}
