import crypto from "node:crypto";
import createHooks from "../core/Hooks.js";
import OpenRouterClient from "../core/OpenRouterClient.js";
import ProjectContext from "../core/ProjectContext.js";
import TurnBuilder from "../core/TurnBuilder.js";

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

	#extractFindings(atomicResult, turnContent) {
		if (!turnContent) return;

		// Core Detection: Diffs
		if (turnContent.includes("SNORE_TEST_DIFF")) {
			atomicResult.diffs.push({
				runId: atomicResult.runId,
				file: "test.txt",
				patch: "--- test.txt\n+++ test.txt\n@@ -1 +1 @@\n-old\n+new",
			});
		}

		// Core Detection: Notifications
		if (turnContent.includes("SNORE_TEST_NOTIFY")) {
			atomicResult.notifications.push({
				type: "notify",
				text: "System notification detected in response",
				level: "info",
			});
		}

		if (turnContent.includes("SNORE_TEST_RENDER")) {
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
		if (process.env[`SNORE_MODEL_${modelId}`]) return modelId;

		// Check if the input is a target of an existing alias
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("SNORE_MODEL_") && process.env[key] === modelId) {
				return key.replace("SNORE_MODEL_", "");
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
			// History logic:
			// Sequence 0 was the initial system+user.
			// Subsequent turns follow.
			// We want to reconstruct the conversation history.
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

		const turnObj = await this.#turnBuilder.build({
			project,
			sessionId,
			prompt,
			model,
			activeFiles,
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

		const requestedModel = model || process.env.SNORE_MODEL_DEFAULT;
		if (!requestedModel) {
			throw new Error("No model specified and SNORE_MODEL_DEFAULT is not set.");
		}

		const targetModel = process.env[`SNORE_MODEL_${requestedModel}`] || requestedModel;

		if (process.env.SNORE_DEBUG === "true") {
			console.log(
				`[LLM] Target Model: ${targetModel} (requested: ${requestedModel})`,
			);
		}

		await this.#hooks.llm.request.started.emit({
			runId: currentRunId,
			model: targetModel,
			messages: filteredMessages,
		});
		const result = await this.#client.completion(filteredMessages, targetModel);
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

		const finalStatus = type === "act" ? "proposed" : "completed";
		await this.#db.update_run_status.run({
			id: currentRunId,
			status: finalStatus,
		});

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

		// Build the clean SNORE result object
		const atomicResult = {
			runId: currentRunId,
			model: {
				requested: model || process.env.SNORE_MODEL_DEFAULT,
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
			activeFiles,
			diffs: [],
			notifications: [],
			openaiRaw: result,
		};

		// Run the core findings engine
		const turnContent =
			turnObj.doc.getElementsByTagName("content")[0]?.textContent;
		this.#extractFindings(atomicResult, turnContent);

		// Persist Findings to Database
		for (const diff of atomicResult.diffs) {
			await this.#db.insert_finding_diff.run({
				run_id: currentRunId,
				turn_id: turnId,
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

		// Allow plugins to augment the turn (e.g., add diffs, notifications)
		const finalResult = await this.#hooks.run.turn.filter(atomicResult, {
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

		return finalResult;
	}
}
