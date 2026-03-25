import fs from "node:fs/promises";
import { join } from "node:path";
import HeuristicMatcher, { generateUnifiedDiff } from "../../extraction/HeuristicMatcher.js";

export default class FindingsManager {
	#db;
	#parser;

	constructor(db, parser) {
		this.#db = db;
		this.#parser = parser;
	}

	async populateFindings(projectPath, atomicResult, tags) {
		const { content: turnContent } = atomicResult;

		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		const projectId = projects[0]?.id;

		// Collect edits per file for merging
		const editsByFile = new Map();

		for (const tag of tags) {
			const { tagName, attrs } = tag;

			if (tagName === "read" && projectId) {
				const path = attrs.find((a) => a.name === "file")?.value;
				if (path) {
					const { id: fileId } = await this.#db.upsert_repo_map_file.get({
						project_id: projectId,
						path,
						hash: null,
						size: null,
						symbol_tokens: null,
					});
					await this.#db.upsert_agent_promotion.run({
						file_id: fileId,
						run_id: atomicResult.runId,
						turn_seq: atomicResult.sequence ?? 0,
					});
				}
			}

			if (tagName === "drop" && projectId) {
				const path = attrs.find((a) => a.name === "file")?.value;
				if (path) {
					const file = await this.#db.get_repo_map_file.get({
						project_id: projectId,
						path,
					});
					if (file) {
						await this.#db.delete_agent_promotion.run({
							file_id: file.id,
							run_id: atomicResult.runId,
						});
					}
				}
			}

			if (tagName === "edit") {
				const path = attrs.find((a) => a.name === "file")?.value;
				const content = this.#parser.getNodeText(tag);
				if (path) {
					const { search, replace } = this.#parseEditTag(content);
					if (!editsByFile.has(path)) editsByFile.set(path, []);
					editsByFile.get(path).push({ search, replace });
				}
			}

			if (tagName === "create" || tagName === "delete") {
				const path = attrs.find((a) => a.name === "file")?.value;
				const content = this.#parser.getNodeText(tag);
				if (path) {
					atomicResult.diffs.push({
						type: tagName,
						file: path,
						patch: content,
						warning: null,
						error: null,
					});
				}
			}

			if (tagName === "run" || tagName === "env") {
				const command = this.#parser.getNodeText(tag);
				atomicResult.commands.push({ type: tagName, command });
			}

			if (tagName === "summary") {
				atomicResult.notifications.push({
					type: "summary",
					text: this.#parser.getNodeText(tag),
					level: "info",
				});
			}

			if (tagName === "prompt_user") {
				atomicResult.notifications.push({
					type: "prompt_user",
					text: this.#parser.getNodeText(tag),
					level: "warn",
					config: this.#parser.parsePromptUser(tag),
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
						warnings.push("Could not parse SEARCH/REPLACE markers from an edit block.");
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
			atomicResult.diffs.push({ type: "edit", file: path, patch, warning, error });
		}

		if (turnContent.includes("RUMMY_TEST_DIFF")) {
			atomicResult.diffs.push({
				type: "create",
				file: "rummy_test.txt",
				patch: "test+new",
				warning: null,
				error: null,
			});
		}
		if (turnContent.includes("RUMMY_TEST_NOTIFY")) {
			atomicResult.notifications.push({
				type: "notify",
				text: "System notification detected in response",
				level: "info",
			});
		}
	}

	#parseEditTag(content) {
		const searchMarker = "<<<<<<< SEARCH";
		const dividerMarker = "=======";
		const replaceMarker = ">>>>>>> REPLACE";

		const searchStart = content.indexOf(searchMarker);
		const dividerStart = content.indexOf(dividerMarker);
		const replaceEnd = content.indexOf(replaceMarker);

		if (searchStart === -1 || dividerStart === -1 || replaceEnd === -1) {
			return { search: null, replace: null };
		}

		const search = content
			.substring(searchStart + searchMarker.length, dividerStart)
			.trim();
		const replace = content
			.substring(dividerStart + dividerMarker.length, replaceEnd)
			.trim();

		return { search, replace };
	}
}
