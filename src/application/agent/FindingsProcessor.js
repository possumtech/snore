import msg from "../../domain/i18n/messages.js";

export default class FindingsProcessor {
	#db;
	#findingsManager;
	#hooks;

	constructor(db, findingsManager, hooks) {
		this.#db = db;
		this.#findingsManager = findingsManager;
		this.#hooks = hooks;
	}

	async process({
		projectPath,
		projectId,
		runId,
		turnId,
		turnSequence,
		tools,
		structural,
		elements,
		turnObj,
		sessionId,
	}) {
		const findings = await this.#findingsManager.processTools(
			projectPath,
			runId,
			Number(turnSequence),
			tools,
		);

		// Persist diffs + emit notifications
		const diffErrors = [];
		for (const diff of findings.diffs) {
			if (diff.error) {
				diffErrors.push({ file: diff.file, error: diff.error });
				continue;
			}
			const row = await this.#db.insert_finding_diff.get({
				run_id: runId,
				turn_id: turnId,
				type: diff.type,
				file_path: diff.file,
				patch: diff.patch,
			});
			await this.#hooks.editor.diff.emit({
				sessionId,
				runId,
				findingId: row?.id,
				type: diff.type,
				file: diff.file,
				patch: diff.patch,
				warning: diff.warning || null,
				error: null,
			});
		}
		if (diffErrors.length > 0) {
			const contextNode = elements.find((el) => el.tag_name === "context");
			if (contextNode) {
				const errorLines = diffErrors
					.map((d) =>
						msg("feedback.diff_error", { file: d.file, error: d.error }),
					)
					.join("\n");
				await this.#db.insert_turn_element.run({
					turn_id: turnId,
					parent_id: contextNode.id,
					tag_name: "feedback",
					content: errorLines,
					attributes: "{}",
					sequence: 180,
				});
			}
		}

		// Persist commands
		for (const cmd of findings.commands) {
			const row = await this.#db.insert_finding_command.get({
				run_id: runId,
				turn_id: turnId,
				type: cmd.type,
				command: cmd.command,
			});
			await this.#hooks.run.command.emit({
				sessionId,
				runId,
				findingId: row?.id,
				type: cmd.type,
				command: cmd.command,
			});
		}

		// Persist notifications
		for (const notif of findings.notifications) {
			const row = await this.#db.insert_finding_notification.get({
				run_id: runId,
				turn_id: turnId,
				type: notif.type,
				text: notif.text,
				level: notif.level || "info",
				status: notif.type === "prompt_user" ? "proposed" : "acknowledged",
				config: notif.config ? JSON.stringify(notif.config) : null,
				append: notif.append ? 1 : 0,
			});
			if (notif.type === "prompt_user" && notif.config) {
				await this.#hooks.ui.prompt.emit({
					sessionId,
					runId,
					findingId: row?.id,
					question: notif.config.question,
					options: notif.config.options,
				});
			}
		}

		// Summary notification
		for (const s of structural) {
			if (s.name === "summary") {
				await this.#db.insert_finding_notification.get({
					run_id: runId,
					turn_id: turnId,
					type: "summary",
					text: s.content,
					level: "info",
					status: "acknowledged",
					config: null,
					append: 0,
				});
			}
		}

		// Inject tool feedback into context
		if (findings.feedback.length > 0) {
			const ctxNode = elements.find((el) => el.tag_name === "context");
			if (ctxNode) {
				await this.#db.insert_turn_element.run({
					turn_id: turnId,
					parent_id: ctxNode.id,
					tag_name: "feedback",
					content: findings.feedback.join("\n"),
					attributes: "{}",
					sequence: 175,
				});
			}
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
					run_id: runId,
					turn_seq: Number(turnSequence),
					mention: String(mention),
				});
			} catch (_err) {}
		}

		return { newReads: findings.newReads };
	}
}
