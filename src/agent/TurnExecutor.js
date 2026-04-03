import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ProjectContext from "../fs/ProjectContext.js";
import RummyContext from "../hooks/RummyContext.js";
import ContextAssembler from "./ContextAssembler.js";
import FileScanner from "./FileScanner.js";
import KnownStore from "./KnownStore.js";
import msg from "./messages.js";
import ResponseHealer from "./ResponseHealer.js";
import { countTokens } from "./tokens.js";
import XmlParser from "./XmlParser.js";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");
let promptCache = null;

export default class TurnExecutor {
	#db;
	#llmProvider;
	#hooks;
	#knownStore;
	#fileScanner;

	constructor(db, llmProvider, hooks, knownStore) {
		this.#db = db;
		this.#llmProvider = llmProvider;
		this.#hooks = hooks;
		this.#knownStore = knownStore;
		this.#fileScanner = new FileScanner(knownStore, db, hooks);
	}

	async #loadPrompt() {
		if (promptCache) return promptCache;
		try {
			promptCache = await fs.readFile(join(ROOT_DIR, "prompt.md"), "utf8");
		} catch {
			throw new Error("prompt.md not found");
		}
		return promptCache;
	}

	async execute({
		mode,
		project,
		projectId,
		currentRunId,
		currentAlias,
		requestedModel,
		loopPrompt,
		noContext,
		contextSize,
		options,
		signal,
	}) {
		const turn = await this.#knownStore.nextTurn(currentRunId);

		const turnRow = await this.#db.create_turn.get({
			run_id: currentRunId,
			sequence: turn,
		});

		const unresolved = await this.#knownStore.getUnresolved(currentRunId);
		if (unresolved.length > 0) {
			throw new Error(
				msg("error.unresolved_proposed", { count: unresolved.length }),
			);
		}

		// File scan
		if (!noContext && project?.project_root) {
			const ctx = await ProjectContext.open(project.project_root);
			const files = await ctx.getMappableFiles();
			await this.#fileScanner.scan(
				project.project_root,
				project.id,
				files,
				turn,
			);
		}

		// Store prompt/progress entries BEFORE plugin hooks and materialization.
		// Plugins can modify progress:// body before it reaches the model.
		if (!options?.isContinuation) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`prompt://${turn}`,
				"",
				"info",
				{ attributes: { mode } },
			);
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`${mode}://${turn}`,
				loopPrompt || "",
				"info",
			);
		} else {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`progress://${turn}`,
				loopPrompt || "",
				"info",
			);
		}

		// Write system://prompt entry — body is prompt.md, attributes carry config.
		// Plugins can modify attributes during onTurn (e.g., push amendments).
		const promptBody = await this.#loadPrompt();
		const runRow2 = await this.#db.get_run_by_id.get({ id: currentRunId });
		const toolNames = this.#hooks.tools
			.namesForMode(mode)
			.map((t) => `\`<${t}/>\``)
			.join(" ");
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			"system://prompt",
			promptBody,
			"info",
			{
				attributes: {
					tools: toolNames,
					persona: runRow2?.persona || null,
					amendments: [],
				},
			},
		);

		// Run plugin hooks (janitor, relevance engine, web plugin amendments, etc.)
		const rummy = new RummyContext(
			{
				tag: "turn",
				attrs: {},
				content: null,
				children: [
					{ tag: "system", attrs: {}, content: null, children: [] },
					{ tag: "context", attrs: {}, content: null, children: [] },
					{ tag: "user", attrs: {}, content: null, children: [] },
					{ tag: "assistant", attrs: {}, content: null, children: [] },
				],
			},
			{
				hooks: this.#hooks,
				db: this.#db,
				store: this.#knownStore,
				project,
				type: mode,
				sequence: turn,
				runId: currentRunId,
				turnId: turnRow.id,
				noContext,
				contextSize,
				systemPrompt: null,
				loopPrompt,
			},
		);
		await this.#hooks.processTurn(rummy);

		// Project system://prompt through the system tool's projection
		const systemEntry = await this.#knownStore.getEntriesByPattern(
			currentRunId,
			"system://prompt",
			null,
		);
		const systemAttrs = systemEntry[0]
			? await this.#knownStore.getAttributes(currentRunId, "system://prompt")
			: null;
		const systemPrompt = this.#hooks.tools.project("system", {
			path: "system://prompt",
			scheme: "system",
			body: systemEntry[0]?.body || promptBody,
			attributes: systemAttrs,
			fidelity: "full",
			category: "system",
		});

		// Materialize turn_context: VIEW rows projected through tools
		await this.#db.clear_turn_context.run({ run_id: currentRunId, turn });
		const viewRows = await this.#db.get_model_context.all({
			run_id: currentRunId,
		});
		for (const row of viewRows) {
			const scheme = row.scheme || "file";
			const projectedBody = this.#hooks.tools.project(scheme, {
				path: row.path,
				scheme,
				body: row.body,
				attributes: row.attributes ? JSON.parse(row.attributes) : null,
				fidelity: row.fidelity,
				category: row.category,
			});

			await this.#db.insert_turn_context.run({
				run_id: currentRunId,
				turn,
				ordinal: row.ordinal,
				path: row.path,
				fidelity: row.fidelity,
				state: row.state,
				body: projectedBody ?? "",
				tokens: countTokens(projectedBody ?? ""),
				attributes: row.attributes,
				category: row.category,
			});
		}

		await this.#hooks.run.progress.emit({
			projectId,
			run: currentAlias,
			turn,
			status: "thinking",
		});

		// Assemble messages from projected system prompt + materialized turn_context
		const rows = await this.#db.get_turn_context.all({
			run_id: currentRunId,
			turn,
		});
		const messages = ContextAssembler.assembleFromTurnContext(rows, {
			type: mode,
			tools: toolNames,
			systemPrompt,
		});

		const filteredMessages = await this.#hooks.llm.messages.filter(messages, {
			model: requestedModel,
			projectId,
			runId: currentRunId,
		});

		// Store assembled messages as audit
		const systemMsg = filteredMessages.find((m) => m.role === "system");
		const userMsg = filteredMessages.find((m) => m.role === "user");
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`system://${turn}`,
			systemMsg?.content || systemPrompt,
			"info",
		);
		if (userMsg) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`user://${turn}`,
				userMsg.content,
				"info",
			);
		}

		if (process.env.RUMMY_DEBUG === "true") {
			console.log(
				"[DEBUG] Messages:",
				JSON.stringify(filteredMessages, null, 2),
			);
		}

		// Call LLM
		await this.#hooks.llm.request.started.emit({ model: requestedModel, turn });
		const rawResult = await this.#llmProvider.completion(
			filteredMessages,
			requestedModel,
			{ temperature: options?.temperature, signal },
		);
		const result = await this.#hooks.llm.response.filter(rawResult, {
			model: requestedModel,
			projectId,
			runId: currentRunId,
		});
		await this.#hooks.llm.request.completed.emit({
			model: requestedModel,
			turn,
			usage: result.usage,
		});
		const responseMessage = result.choices?.[0]?.message;
		const content = responseMessage?.content || "";

		if (process.env.RUMMY_DEBUG === "true") {
			console.log("[DEBUG] Response content:", content.slice(0, 500));
		}

		// Store full assistant response as audit
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`assistant://${turn}`,
			content,
			"info",
		);

		await this.#hooks.run.progress.emit({
			projectId,
			run: currentAlias,
			turn,
			status: "processing",
		});

		// Parse XML commands from content
		const { commands, unparsed } = XmlParser.parse(content);

		// Store raw API response diagnostics
		await this.#knownStore.upsert(
			currentRunId,
			turn,
			`model://${turn}`,
			JSON.stringify({
				keys: responseMessage ? Object.keys(responseMessage) : [],
				reasoning_content: responseMessage?.reasoning_content || null,
				content: content.slice(0, 4096),
				usage: result.usage || null,
				model: result.model || requestedModel,
			}),
			"info",
		);

		if (responseMessage?.reasoning_content) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`reasoning://${turn}`,
				responseMessage.reasoning_content,
				"info",
			);
		}

		if (unparsed) {
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				`content://${turn}`,
				unparsed,
				"info",
			);
		}

		// Commit usage
		const usage = result.usage || {};
		await this.#db.update_turn_stats.run({
			id: turnRow.id,
			prompt_tokens: Number(usage.prompt_tokens || 0),
			completion_tokens: Number(usage.completion_tokens || 0),
			total_tokens: Number(usage.total_tokens || 0),
			cost: Number(usage.cost || 0),
		});

		// --- PHASE 1: RECORD ---
		// Every command becomes an entry. No execution yet.

		const recorded = [];
		let summaryText = null;
		let updateText = null;

		for (const cmd of commands) {
			const entry = await this.#record(currentRunId, turn, mode, cmd);
			if (!entry) continue;

			if (entry.scheme === "summarize") summaryText = entry.body;
			else if (entry.scheme === "update") updateText = entry.body;
			else recorded.push(entry);
		}

		// If model sent both, summary wins
		if (summaryText && updateText) updateText = null;

		// If model sent neither, heal from content
		let statusHealed = false;
		if (!summaryText && !updateText) {
			const healed = ResponseHealer.healStatus(content, commands);
			summaryText = healed.summaryText;
			updateText = healed.updateText;
			statusHealed = true;
		}

		// Record healed status
		if (summaryText) {
			const summaryPath = await this.#knownStore.slugPath(
				currentRunId,
				"summarize",
				summaryText,
			);
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				summaryPath,
				summaryText,
				"summary",
			);
		} else if (updateText) {
			const updatePath = await this.#knownStore.slugPath(
				currentRunId,
				"update",
				updateText,
			);
			await this.#knownStore.upsert(
				currentRunId,
				turn,
				updatePath,
				updateText,
				"info",
			);
		}

		// --- PHASE 2: DISPATCH ---
		// Handlers perform side effects: promote, demote, patch, propose.

		for (const entry of recorded) {
			await this.#hooks.tools.dispatch(entry.scheme, entry, rummy);
			await this.#hooks.entry.created.emit(entry);
		}

		// --- Classify for return value ---

		const actionCalls = recorded.filter((e) =>
			[
				"read",
				"store",
				"write",
				"delete",
				"move",
				"copy",
				"run",
				"env",
				"search",
			].includes(e.scheme),
		);
		const writeCalls = recorded.filter(
			(e) =>
				e.scheme === "known" ||
				(e.scheme === "write" &&
					!e.attributes?.blocks &&
					!e.attributes?.search),
		);
		const unknownCalls = recorded.filter((e) => e.scheme === "unknown");

		const hasAct = actionCalls.some((c) =>
			["write", "delete", "run", "move", "copy"].includes(c.scheme),
		);
		const hasReads = actionCalls.some((c) =>
			["read", "env", "search"].includes(c.scheme),
		);
		const hasWrites = writeCalls.length > 0 || unknownCalls.length > 0;
		const flags = { hasAct, hasReads, hasWrites };

		const askUserEntry = recorded.find((e) => e.scheme === "ask_user");

		return {
			turn,
			turnId: turnRow.id,
			actionCalls,
			writeCalls,
			unknownCalls,
			summaryText,
			updateText,
			statusHealed,
			askUserCmd: askUserEntry || null,
			flags,
			model: result.model || requestedModel,
			modelAlias: requestedModel,
			temperature:
				options?.temperature ??
				Number.parseFloat(process.env.RUMMY_TEMPERATURE || "0.7"),
			contextSize,
			usage,
		};
	}

	/**
	 * Record a parsed command as a known_entries row.
	 * Returns the recorded entry descriptor, or null if rejected/skipped.
	 */
	async #record(runId, turn, mode, cmd) {
		// Mode enforcement — reject prohibited commands in ask mode
		if (mode === "ask") {
			if (cmd.name === "run") {
				console.warn("[RUMMY] Rejected <run> in ask mode");
				return null;
			}
			if (cmd.name === "write" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) {
					console.warn(
						`[RUMMY] Rejected file write to ${cmd.path} in ask mode`,
					);
					return null;
				}
			}
			if (cmd.name === "delete" && cmd.path) {
				const scheme = KnownStore.scheme(cmd.path);
				if (scheme === null) {
					console.warn(
						`[RUMMY] Rejected file delete of ${cmd.path} in ask mode`,
					);
					return null;
				}
			}
			if ((cmd.name === "move" || cmd.name === "copy") && cmd.to) {
				const destScheme = KnownStore.scheme(cmd.to);
				if (destScheme === null) {
					console.warn(
						`[RUMMY] Rejected ${cmd.name} to file ${cmd.to} in ask mode`,
					);
					return null;
				}
			}
		}

		const scheme = cmd.name;

		// Structural tags — record and return (no handler dispatch)
		if (scheme === "summarize" || scheme === "update") {
			return { scheme, body: cmd.body, resultPath: null, attributes: null };
		}

		// Unknown — deduplicated, sticky
		if (scheme === "unknown") {
			const existingValues = await this.#knownStore.getUnknownValues(runId);
			if (existingValues.has(cmd.body)) return null;
			const unknownPath = await this.#knownStore.slugPath(
				runId,
				"unknown",
				cmd.body,
			);
			await this.#knownStore.upsert(runId, turn, unknownPath, cmd.body, "full");
			return {
				scheme,
				path: unknownPath,
				body: cmd.body,
				resultPath: unknownPath,
				attributes: null,
			};
		}

		// Build the result path (where the tool result entry goes)
		const target = cmd.path || cmd.command || cmd.question || "";
		const resultPath = await this.#knownStore.slugPath(runId, scheme, target);

		// Build attributes from the command's parsed fields
		const attributes = {};
		if (cmd.path) attributes.path = cmd.path;
		if (cmd.body !== undefined && cmd.body !== "") attributes.body = cmd.body;
		if (cmd.command) attributes.command = cmd.command;
		if (cmd.question) attributes.question = cmd.question;
		if (cmd.options) attributes.options = cmd.options;
		if (cmd.to) attributes.to = cmd.to;
		if (cmd.search != null) attributes.search = cmd.search;
		if (cmd.replace != null) attributes.replace = cmd.replace;
		if (cmd.blocks) attributes.blocks = cmd.blocks;
		if (cmd.filter) attributes.filter = cmd.filter;
		if (cmd.preview) attributes.preview = cmd.preview;
		if (cmd.results) attributes.results = cmd.results;

		// Naked write (no path) → known:// slug from body
		if (scheme === "write" && !cmd.path) {
			if (!cmd.body) return null;
			const knownPath = await this.#knownStore.slugPath(
				runId,
				"known",
				cmd.body,
			);
			await this.#knownStore.upsert(runId, turn, knownPath, cmd.body, "full");
			return {
				scheme: "known",
				path: knownPath,
				body: cmd.body,
				resultPath: knownPath,
				attributes,
			};
		}

		// Record the entry
		const body = cmd.body || cmd.command || cmd.question || "";
		const state = this.#initialState(scheme);
		await this.#knownStore.upsert(runId, turn, resultPath, body, state, {
			attributes,
		});

		return {
			scheme,
			path: resultPath,
			body,
			attributes,
			state,
			resultPath,
		};
	}

	/**
	 * Initial state for a recorded command entry.
	 * All entries start at "full". Handlers change state during dispatch.
	 */
	#initialState(_scheme) {
		return "full";
	}
}
