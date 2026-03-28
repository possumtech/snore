import msg from "../../domain/i18n/messages.js";

export default class StateEvaluator {
	#db;
	#hooks;

	constructor(db, hooks) {
		this.#db = db;
		this.#hooks = hooks;
	}

	async evaluate({
		flags,
		tools,
		turnJson,
		finalResponse,
		runId,
		turnId,
		elements,
		inconsistencyRetries,
		maxInconsistencyRetries,
		parsedTodo,
	}) {
		const { hasAct, hasSummary, newReads = 0 } = flags;
		const unknowns = turnJson.assistant.unknown || [];
		const openUnknowns = Array.isArray(unknowns) ? unknowns.length > 0 : false;
		const hasTools = tools.length > 0;
		const proposed = await this.#db.get_unresolved_findings.all({
			run_id: runId,
		});

		// Cross-validate: todo lists edit but no edits array entries
		const todoItems = parsedTodo || [];
		const _todoHasEdit = todoItems.some(
			(t) => t.tool === "edit" || t.tool === "create",
		);
		const _hasEdits = tools.some(
			(t) => t.tool === "edit" || t.tool === "create",
		);

		// Collect warnings — hookable via agent.warn filter
		let warnRules = [
			{
				when: openUnknowns && hasSummary,
				msg: msg("warn.unknown_with_summary"),
			},
			{ when: openUnknowns && !hasTools, msg: msg("warn.unknown_no_tools") },
		];
		warnRules = await this.#hooks.agent.warn.filter(warnRules, {
			flags,
			tools,
			turnJson,
			finalResponse,
			parsedTodo: todoItems,
		});

		const warnings = warnRules.filter((w) => w.when);

		// Inject warnings into context
		if (warnings.length > 0) {
			const ctxNode = elements.find((el) => el.tag_name === "context");
			if (ctxNode) {
				const feedbackLines = warnings.map((w) => `warn: ${w.msg}`).join("\n");
				await this.#db.insert_turn_element.run({
					turn_id: turnId,
					parent_id: ctxNode.id,
					tag_name: "feedback",
					content: feedbackLines,
					attributes: "{}",
					sequence: 190,
				});
			}
		}

		// Action table — hookable via agent.action filter
		let actionTable = [
			{ when: proposed.length > 0, action: "proposed" },
			{ when: hasAct, action: "continue" },
			{ when: newReads > 0, action: "continue" },
			{
				when:
					warnings.length > 0 && inconsistencyRetries < maxInconsistencyRetries,
				action: "retry",
			},
			{ when: hasSummary, action: "completed" },
			{ when: true, action: "completed" },
		];
		actionTable = await this.#hooks.agent.action.filter(actionTable, {
			flags,
			tools,
			turnJson,
			warnings,
			proposed,
		});

		const rule = actionTable.find((r) => r.when);

		return {
			action: rule.action,
			warnings,
			proposed,
			hasSummary,
		};
	}
}
