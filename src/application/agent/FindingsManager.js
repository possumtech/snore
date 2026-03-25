import fs from "node:fs/promises";
import { join } from "node:path";
import HeuristicMatcher from "../../extraction/HeuristicMatcher.js";

/**
 * FindingsManager: Handles tag processing and finding extraction.
 * The server never touches the filesystem — all findings are proposed
 * to the client for resolution. Edit diffs are resolved against the
 * actual file content via HeuristicMatcher to produce unified diffs.
 */
export default class FindingsManager {
	#db;
	#parser;

	constructor(db, parser) {
		this.#db = db;
		this.#parser = parser;
	}

	/**
	 * Extracts proposed changes and information from model tags.
	 */
	async populateFindings(projectPath, atomicResult, tags) {
		const { content: turnContent } = atomicResult;

		// 1. Resolve Project ID for relational updates
		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		const projectId = projects[0]?.id;

		for (const tag of tags) {
			const { tagName, attrs } = tag;

			// PROMOTION TAGS (Agent Focus)
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

			// DIFF TAGS
			if (tagName === "edit" || tagName === "create" || tagName === "delete") {
				const path = attrs.find((a) => a.name === "file")?.value;
				const content = this.#parser.getNodeText(tag);
				if (path) {
					if (tagName === "edit") {
						const { search, replace } = this.#parseEditTag(content);
						let patch = null;
						let warning = null;
						let error = null;

						if (search && replace) {
							try {
								const fullPath = join(projectPath, path);
								const fileContent = await fs.readFile(fullPath, "utf8");
								const result = HeuristicMatcher.matchAndPatch(
									path,
									fileContent,
									search,
									replace,
								);
								if (result.error) {
									error = result.error;
								} else {
									patch = result.patch;
									warning = result.warning;
								}
							} catch (err) {
								error = `Could not read file for diff resolution: ${err.message}`;
							}
						} else {
							error = "Could not parse SEARCH/REPLACE markers from edit tag.";
						}

						atomicResult.diffs.push({
							type: tagName,
							file: path,
							patch,
							warning,
							error,
						});
					} else {
						atomicResult.diffs.push({
							type: tagName,
							file: path,
							patch: content,
						});
					}
				}
			}

			// COMMAND TAGS
			if (tagName === "run" || tagName === "env") {
				const command = this.#parser.getNodeText(tag);
				atomicResult.commands.push({ type: tagName, command });
			}

			// NOTIFICATION TAGS
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

		// Legacy/Test markers
		if (turnContent.includes("RUMMY_TEST_DIFF")) {
			atomicResult.diffs.push({
				type: "create",
				file: "rummy_test.txt",
				patch: "test+new",
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
