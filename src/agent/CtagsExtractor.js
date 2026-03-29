import { spawnSync as defaultSpawnSync } from "node:child_process";

/**
 * CtagsExtractor handles fallback symbol extraction using Universal Ctags.
 * It contains targeted hacks for languages like Lua where ctags metadata is sparse.
 */
export default class CtagsExtractor {
	#root;
	#spawnSync;

	constructor(root, spawnSync = defaultSpawnSync) {
		this.#root = root;
		this.#spawnSync = spawnSync;
	}

	extract(paths) {
		const result = this.#spawnSync(
			"ctags",
			["--output-format=json", "--fields=+nS", "-f", "-", ...paths],
			{ cwd: this.#root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
		);

		if (result.error && result.error.code === "ENOENT") {
			console.warn("[RUMMY] skipping ctags: not installed.");
			return new Map(paths.map((p) => [p, []]));
		}

		if (result.status !== 0) {
			console.warn(`[RUMMY] skipping ctags: failed (${result.stderr})`);
			return new Map(paths.map((p) => [p, []]));
		}

		const tags = result.stdout
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));

		const grouped = new Map();
		for (const path of paths) grouped.set(path, []);

		for (const tag of tags) {
			const symbols = grouped.get(tag.path);
			if (symbols) {
				symbols.push(this.#processTag(tag));
			}
		}

		return grouped;
	}

	#processTag(tag) {
		let params = tag.signature || null;

		// LUA HACK: ctags doesn't provide signatures for Lua, but they are in the pattern.
		// Handles both 'function name(params)' and 'name = function(params)'
		if (!params && tag.path.endsWith(".lua") && tag.pattern && tag.name) {
			const escapedName = tag.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(
				`${escapedName}\\s*(?:=\\s*function\\s*)?(\\(.*?\\))`,
			);
			const match = tag.pattern.match(regex);
			if (match) {
				params = match[1];
			}
		}

		return {
			name: tag.name,
			type: tag.kind,
			params,
			line: tag.line,
			source: "standard",
		};
	}
}
