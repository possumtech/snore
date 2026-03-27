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
		tags,
	}) {
		const { hasAct, hasReads, hasSummary } = flags;
		const unkRaw = (turnJson.assistant.unknown || "")
			.trim()
			.replace(/^[-*]\s*/, "");
		const openUnknowns =
			unkRaw.length > 0 && !/^(none\.?|n\/a|nothing\.?|-)$/i.test(unkRaw);
		const hasTools = tools.length > 0;
		const proposed = hasAct
			? await this.#db.get_unresolved_findings.all({ run_id: runId })
			: [];

		// Detect stray output outside structured tags
		const allowedTagPattern =
			/<(?:todo|known|unknown|edit)[^>]*>[\s\S]*?<\/(?:todo|known|unknown|edit)>/gi;
		const strippedContent = (finalResponse.content || "")
			.replace(allowedTagPattern, "")
			.replace(/<(?:todo|known|unknown|edit)[^>]*\/>/gi, "")
			.trim();
		const hasStrayOutput =
			strippedContent.length > 0 && !/^[\s\n]*$/.test(strippedContent);

		// Cross-validate todo items against actual output
		const todoItems = parsedTodo || [];
		const editTags = (tags || []).filter((t) => t.tagName === "edit");
		const todoHasEdit = todoItems.some(
			(t) => !t.completed && (t.tool === "edit" || t.tool === "create"),
		);
		const allTodoComplete =
			todoItems.length > 0 && todoItems.every((t) => t.completed);

		// Collect warnings — hookable via agent.warn filter
		let warnRules = [
			{
				when: hasSummary && openUnknowns,
				msg: "Summary provided but <unknown> is not empty. Either resolve unknowns with tools or clear <unknown></unknown> before summarizing.",
			},
			{
				when: openUnknowns && !hasTools,
				msg: "<unknown> has content but no tools were listed. Example:\n<todo>\n- [ ] read: path/to/file # investigate the unknown\n</todo>",
			},
			{
				when: !hasTools && !hasSummary,
				msg: "No tools and no summary. When work is complete, include a summary tool. Example:\n<todo>\n- [ ] summary: Described the module architecture\n</todo>",
			},
			{
				when: hasStrayOutput,
				msg: "Output detected outside structured tags. ALL output must be inside <todo>, <known>, <unknown>, or <edit> tags. Plain text between tags is discarded.",
			},
			{
				when: todoHasEdit && editTags.length === 0,
				msg: 'Todo lists edit: or create: but no <edit> tag was provided. Include an <edit file="path"> block after the core tags.',
			},
			{
				when: allTodoComplete && !hasSummary,
				msg: "All todo items are checked but no summary: tool was included. Add a summary when work is complete. Example:\n<todo>\n- [ ] summary: Completed the requested changes\n</todo>",
			},
		];
		warnRules = await this.#hooks.agent.warn.filter(warnRules, {
			flags,
			tools,
			turnJson,
			finalResponse,
			parsedTodo: todoItems,
			tags,
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
			{ when: hasReads, action: "continue" },
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
