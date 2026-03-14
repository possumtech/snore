import { readFileSync } from "node:fs";
import { join } from "node:path";
import GitProvider from "./GitProvider.js";
import FsProvider from "./FsProvider.js";

export const FileState = {
	INVISIBLE: "invisible",
	IGNORED: "ignored",
	MAPPABLE: "mappable",
	MAPPED: "mapped",
	READ_ONLY: "read_only",
	ACTIVE: "active",
};

export default class ProjectContext {
	#root;
	#isGit = false;
	#trackedFiles = new Set();
	#config = {
		ignored: [],
		read_only: [],
		active: [],
	};

	constructor(root, isGit, trackedFiles, config) {
		this.#root = root;
		this.#isGit = isGit;
		this.#trackedFiles = trackedFiles;
		this.#config = config;
	}

	/**
	 * Static factory to initialize a ProjectContext correctly (handling async).
	 */
	static async open(path) {
		const root = (await GitProvider.detectRoot(path)) || path;
		const isGit = (await GitProvider.detectRoot(path)) !== null;
		let trackedFiles = new Set();

		if (isGit) {
			trackedFiles = await GitProvider.getTrackedFiles(root);
		}

		let config = {
			ignored: [],
			read_only: [],
			active: [],
		};

		const configPath = join(root, ".nzi.json");
		try {
			const raw = readFileSync(configPath, "utf8");
			const parsed = JSON.parse(raw);
			config = {
				ignored: parsed.ignored || [],
				read_only: parsed.read_only || [],
				active: parsed.active || [],
			};
		} catch {
			// Config missing or invalid
		}

		return new ProjectContext(root, isGit, trackedFiles, config);
	}

	/**
	 * Resolves the state of a file based on the resolution hierarchy.
	 * @param {string} relPath - Path relative to project root.
	 * @returns {Promise<string>} - The FileState.
	 */
	async resolveState(relPath) {
		// 1. User Overrides (.nzi.json)
		if (this.#config.ignored.includes(relPath)) return FileState.IGNORED;
		if (this.#config.active.includes(relPath)) return FileState.ACTIVE;
		if (this.#config.read_only.includes(relPath)) return FileState.READ_ONLY;

		// 2. Git Status
		if (this.#isGit) {
			if (this.#trackedFiles.has(relPath)) return FileState.MAPPABLE;
			if (await GitProvider.isIgnored(this.#root, relPath)) return FileState.IGNORED;
			return FileState.INVISIBLE;
		}

		// 3. FS Fallback (Non-Git)
		const systemIgnores = ["node_modules", ".git", ".venv", ".DS_Store"];
		const parts = relPath.split("/");
		if (parts.some((p) => systemIgnores.includes(p))) return FileState.IGNORED;

		return FileState.MAPPABLE;
	}

	get root() {
		return this.#root;
	}

	get isGit() {
		return this.#isGit;
	}

	/**
	 * Returns all files that should be considered for mapping.
	 * @returns {Promise<string[]>}
	 */
	async getMappableFiles() {
		if (this.#isGit) {
			const all = new Set([...this.#trackedFiles]);
			for (const p of [...this.#config.active, ...this.#config.read_only]) {
				all.add(p);
			}
			for (const p of this.#config.ignored) {
				all.delete(p);
			}
			return Array.from(all);
		}

		// Non-Git fallback
		const files = FsProvider.listFiles(this.#root);
		const filtered = [];
		for (const f of files) {
			if ((await this.resolveState(f)) !== FileState.IGNORED) {
				filtered.push(f);
			}
		}
		return filtered;
	}
}
