import fs from "node:fs/promises";
import { join } from "node:path";
import HeuristicMatcher, {
	generateUnifiedDiff,
} from "../../extraction/HeuristicMatcher.js";

/**
 * FindingsManager: Processes tool invocations into findings.
 * Consumes structured tool calls from ToolExtractor, not raw tags.
 */
export default class FindingsManager {
	#db;

	constructor(db) {
		this.#db = db;
	}

	/**
	 * Process tool invocations into findings (diffs, commands, notifications)
	 * and file promotions.
	 */
	async processTools(projectPath, runId, sequence, tools) {
		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		const projectId = projects[0]?.id;

		const editsByFile = new Map();
		const diffs = [];
		const commands = [];
		const notifications = [];

		for (const invocation of tools) {
			const { tool } = invocation;

			if (tool === "read" && projectId) {
				const { id: fileId } = await this.#db.upsert_repo_map_file.get({
					project_id: projectId,
					path: invocation.path,
					hash: null,
					size: null,
					symbol_tokens: null,
				});
				await this.#db.upsert_agent_promotion.run({
					file_id: fileId,
					run_id: runId,
					turn_seq: sequence ?? 0,
				});
			}

			if (tool === "drop" && projectId) {
				const file = await this.#db.get_repo_map_file.get({
					project_id: projectId,
					path: invocation.path,
				});
				if (file) {
					await this.#db.delete_agent_promotion.run({
						file_id: file.id,
						run_id: runId,
					});
				}
			}

			if (tool === "edit") {
				if (!editsByFile.has(invocation.path)) {
					editsByFile.set(invocation.path, []);
				}
				editsByFile.get(invocation.path).push({
					search: invocation.search,
					replace: invocation.replace,
				});
			}

			if (tool === "create" || tool === "delete") {
				diffs.push({
					type: tool,
					file: invocation.path,
					patch: invocation.content || null,
					warning: null,
					error: null,
				});
			}

			if (tool === "run" || tool === "env") {
				commands.push({ type: tool, command: invocation.command });
			}

			if (tool === "prompt_user") {
				notifications.push({
					type: "prompt_user",
					text: invocation.text,
					level: "warn",
					config: invocation.config,
				});
			}
		}

		// Merge multiple edits per file into a single patch
		for (const [path, edits] of editsByFile) {
			let patch = null;
			let warning = null;
			let error = null;
			const warnings = [];

			try {
				const fullPath = join(projectPath, path);
				const originalContent = await fs.readFile(fullPath, "utf8");
				let currentContent = originalContent;

				for (const edit of edits) {
					if (!edit.search || !edit.replace) {
						warnings.push(
							"Could not parse SEARCH/REPLACE markers from an edit block.",
						);
						continue;
					}
					const result = HeuristicMatcher.matchAndPatch(
						path,
						currentContent,
						edit.search,
						edit.replace,
					);
					if (result.error) {
						warnings.push(result.error);
					} else {
						currentContent = result.newContent;
						if (result.warning) warnings.push(result.warning);
					}
				}

				if (currentContent !== originalContent) {
					patch = generateUnifiedDiff(path, originalContent, currentContent);
				}
			} catch (err) {
				error = `Could not read file for diff resolution: ${err.message}`;
			}

			if (warnings.length > 0) warning = warnings.join(" ");
			diffs.push({ type: "edit", file: path, patch, warning, error });
		}

		return { diffs, commands, notifications };
	}
}
