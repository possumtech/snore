/**
 * GitPlugin: Logic for tracking local changes since the last turn.
 */
export default class GitPlugin {
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
				const { join } = await import("node:path");
				const { existsSync, readFileSync } = await import("node:fs");
				const crypto = await import("node:crypto");

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
				const gitEl = rummy.tag("git_changes", {}, [
					modified.map((p) => `Modified: ${p}`).join("\n"),
				]);
				rummy.contextEl.appendChild(gitEl);
			}
		});
	}
}
