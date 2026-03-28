import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FileChangePlugin: Detects files modified since they were last indexed.
 * Compares stored SHA-256 hashes against current disk content.
 */
export default class FileChangePlugin {
	static register(hooks) {
		hooks.onTurn(async (rummy) => {
			const { project, db } = rummy;
			if (!project?.id || !db) return;
			if (rummy.noContext) return;

			const indexedFiles = await db.get_project_repo_map.all({
				project_id: project.id,
			});
			const modified = [];

			for (const f of indexedFiles) {
				const fullPath = join(project.path, f.path);
				if (!existsSync(fullPath)) continue;

				const content = readFileSync(fullPath, "utf8");
				const currentHash = crypto
					.createHash("sha256")
					.update(content)
					.digest("hex");

				if (f.hash && f.hash !== currentHash) {
					modified.push(f.path);
				}
			}

			if (modified.length > 0) {
				const el = rummy.tag("modified_files", {}, [
					modified.map((p) => `Modified: ${p}`).join("\n"),
				]);
				rummy.contextEl.children.push(el);
			}
		});
	}
}
