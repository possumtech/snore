import fs from "node:fs/promises";
import { join } from "node:path";
import HeuristicMatcher from "../../extraction/HeuristicMatcher.js";

/**
 * FindingsManager: Handles tag processing, patches, and declarative resolution.
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
		const { runId, content: turnContent } = atomicResult;

		// 1. Resolve Project ID for relational updates
		const projects = await this.#db.get_project_by_path.all({
			path: projectPath,
		});
		const projectId = projects[0]?.id;

		for (const tag of tags) {
			const { tagName, attrs } = tag;

			// PERSISTENCE TAGS (Model Focus)
			if (tagName === "read" && projectId) {
				const path = attrs.find((a) => a.name === "file")?.value;
				if (path) {
					await this.#db.set_retained.run({ project_id: projectId, path, is_retained: 1 });
				}
			}

			if (tagName === "drop" && projectId) {
				const path = attrs.find((a) => a.name === "file")?.value;
				if (path) {
					await this.#db.set_retained.run({ project_id: projectId, path, is_retained: 0 });
				}
			}

			// DIFF TAGS
			if (tagName === "edit" || tagName === "create" || tagName === "delete") {
				const path = attrs.find((a) => a.name === "file")?.value;
				const patch = this.#parser.getNodeText(tag);
				if (path) {
					atomicResult.diffs.push({ type: tagName, file: path, patch });
				}
			}

			// COMMAND TAGS
			if (tagName === "run" || tagName === "env") {
				const command = this.#parser.getNodeText(tag);
				atomicResult.commands.push({ type: tagName, command });
			}

			// NOTIFICATION TAGS
			if (tagName === "remark") {
				atomicResult.notifications.push({
					type: "short",
					text: this.#parser.getNodeText(tag),
					level: "info",
				});
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

			if (tagName === "analysis") {
				atomicResult.analysis = this.#parser.getNodeText(tag);
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

	async resolveOutstandingFindings(projectPath, runId, prompt, infoTags) {
		const findings = await this.#db.get_findings_by_run_id.all({
			run_id: runId,
		});
		let resolvedCount = 0;

		for (const tag of infoTags) {
			const diffId = tag.attrs.find((a) => a.name === "diff")?.value;
			const cmdId = tag.attrs.find((a) => a.name === "command")?.value;
			const notifId = tag.attrs.find((a) => a.name === "notification")?.value;
			const action = this.#parser.getNodeText(tag);

			if (diffId) {
				const f = findings.find((x) => x.id === Number.parseInt(diffId));
				if (f && f.status === "proposed") {
					const status = action === "accepted" ? "accepted" : "rejected";
					if (status === "accepted") {
						await this.applyDiff(projectPath, f);
					}
					await this.#db.update_finding_diff_status.run({ id: f.id, status });
					resolvedCount++;
				}
			}

			if (cmdId) {
				const f = findings.find((x) => x.id === Number.parseInt(cmdId));
				if (f && f.status === "proposed") {
					const status = action === "accepted" ? "accepted" : "rejected";
					await this.#db.update_finding_command_status.run({ id: f.id, status });
					resolvedCount++;
				}
			}

			if (notifId) {
				const f = findings.find((x) => x.id === Number.parseInt(notifId));
				if (f && f.status === "proposed") {
					await this.#db.update_finding_notification_status.run({
						id: f.id,
						status: "responded",
					});
					resolvedCount++;
				}
			}
		}

		const remaining = await this.#db.get_findings_by_run_id.all({
			run_id: runId,
		});
		const proposed = remaining.filter((f) => f.status === "proposed");

		return {
			resolvedCount,
			remainingCount: proposed.length,
			proposed,
		};
	}

	async applyDiff(projectPath, diff) {
		const fullPath = join(projectPath, diff.file);

		if (diff.type === "create") {
			await fs.writeFile(fullPath, diff.patch, "utf8");
			return;
		}

		if (diff.type === "delete") {
			await fs.unlink(fullPath).catch(() => {});
			return;
		}

		if (diff.type === "edit") {
			const oldContent = await fs.readFile(fullPath, "utf8");
			const { patch } = HeuristicMatcher.matchAndPatch(
				diff.file,
				oldContent,
				diff.search, // Note: we'll need to update schema/parser to store search/replace
				diff.replace,
			);

			if (patch) {
				// For now we trust the patch since we don't have search/replace separated in DB yet
				// This part will be updated in next iteration of Findings refinement.
				const newContent = diff.patch; // Temporary: trust the patch
				if (newContent) {
					await fs.writeFile(fullPath, newContent, "utf8");
				} else {
					throw new Error(`Failed to apply patch to ${diff.file}`);
				}
			}
		}
	}
}
