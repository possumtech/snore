import fs from "node:fs/promises";
import { join } from "node:path";
import HeuristicMatcher from "../core/HeuristicMatcher.js";

/**
 * FindingsManager: Handles tag processing, patches, and declarative resolution.
 */
export default class FindingsManager {
	#db;
	#responseParser;

	constructor(db, responseParser) {
		this.#db = db;
		this.#responseParser = responseParser;
	}

	async populateFindings(projectPath, atomicResult, tags) {
		for (const tag of tags) {
			if (
				tag.tagName === "edit" ||
				tag.tagName === "create" ||
				tag.tagName === "delete"
			) {
				const file = tag.attrs.find((a) => a.name === "file")?.value;
				if (file) {
					let patchContent = this.#responseParser.getNodeText(tag).trim();

					if (tag.tagName === "edit") {
						try {
							const fullPath = join(projectPath, file);
							const fileContent = await fs.readFile(fullPath, "utf8");
							const searchMatch = patchContent.match(
								/<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n/,
							);
							const replaceMatch = patchContent.match(
								/=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/,
							);

							if (searchMatch && replaceMatch) {
								const searchBlock = searchMatch[1];
								const replaceBlock = replaceMatch[1];
								const matchResult = HeuristicMatcher.matchAndPatch(
									file,
									fileContent,
									searchBlock,
									replaceBlock,
								);

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
					command: this.#responseParser.getNodeText(tag).trim(),
				});
			} else if (tag.tagName === "prompt_user") {
				const { question, options } = this.#responseParser.parsePromptUser(tag);
				atomicResult.notifications.push({
					type: tag.tagName,
					text: question,
					status: "proposed",
					config: { options }
				});
			} else if (tag.tagName === "summary") {
				atomicResult.notifications.push({
					type: tag.tagName,
					text: this.#responseParser.getNodeText(tag).trim(),
				});
			} else if (tag.tagName === "analysis") {
				atomicResult.analysis = this.#responseParser.getNodeText(tag).trim();
			}
		}

		// Legacy test markers
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

	async resolveOutstandingFindings(projectPath, runId, _prompt, infoTags) {
		const findings = await this.#db.get_findings_by_run_id.all({
			run_id: runId,
		});
		const proposed = findings.filter((f) => f.status === "proposed");
		if (proposed.length === 0) return { resolvedCount: 0, remainingCount: 0 };

		let resolvedCount = 0;
		for (const tag of infoTags) {
			const diffId = tag.attrs.find((a) => a.name === "diff")?.value;
			const cmdId = tag.attrs.find((a) => a.name === "command")?.value;
			const noteId = tag.attrs.find((a) => a.name === "notification")?.value;
			const resolution = this.#responseParser.getNodeText(tag).trim();

			if (diffId) {
				const finding = proposed.find(
					(f) => f.category === "diff" && String(f.id) === diffId,
				);
				if (finding) {
					const status =
						resolution.toLowerCase() === "accepted" ? "accepted" : "rejected";
					if (status === "accepted") {
						await this.applyDiff(projectPath, finding);
					}
					await this.#db.update_finding_diff_status.run({
						id: finding.id,
						status,
					});
					resolvedCount++;
				}
			} else if (cmdId) {
				const finding = proposed.find(
					(f) => f.category === "command" && String(f.id) === cmdId,
				);
				if (finding) {
					const status =
						resolution.toLowerCase() === "accepted" ? "accepted" : "rejected";
					await this.#db.update_finding_command_status.run({
						id: finding.id,
						status,
					});
					resolvedCount++;
				}
			} else if (noteId) {
				const finding = proposed.find(
					(f) => f.category === "notification" && String(f.id) === noteId,
				);
				if (finding) {
					await this.#db.update_finding_notification_status.run({
						id: finding.id,
						status: "responded",
					});
					resolvedCount++;
				}
			}
		}

		// Re-fetch to get updated statuses
		const updatedFindings = await this.#db.get_findings_by_run_id.all({
			run_id: runId,
		});
		const remainingProposed = updatedFindings.filter(
			(f) => f.status === "proposed",
		);
		const remainingCount = remainingProposed.length;

		return {
			resolvedCount,
			remainingCount,
			proposed: updatedFindings, // Return all for filtering in the loop
		};
	}

	async applyDiff(projectPath, diff) {
		const fullPath = join(projectPath, diff.file);
		if (diff.type === "delete") {
			await fs.unlink(fullPath).catch(() => {});
		} else if (diff.type === "create" || diff.type === "edit") {
			if (diff.type === "create") {
				await fs.writeFile(fullPath, diff.patch, "utf8");
			} else {
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
}
