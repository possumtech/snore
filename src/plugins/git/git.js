/**
 * FileChangePlugin: Detects files modified since last indexed.
 * TODO: Rewrite to compare known_entries.hash against disk.
 * Currently a stub — change detection deferred to FileScanner.
 */
export default class FileChangePlugin {
	static register(hooks) {
		hooks.onTurn(async (rummy) => {
			if (!rummy.project?.id || !rummy.db) return;
			if (rummy.noContext) return;
			// File change detection happens here once FileScanner is built.
			// The scanner compares known_entries.hash against current disk hash
			// and updates entries whose files changed.
		});
	}
}
