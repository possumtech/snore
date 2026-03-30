import { isAbsolute, join, relative } from "node:path";
import GitProvider from "./GitProvider.js";

// Cache: path → { headHash, context }
const cache = new Map();

export default class ProjectContext {
	#root;
	#isGit = false;
	#trackedFiles = new Set();
	#dbFiles = new Set();

	constructor(root, isGit, trackedFiles, dbFiles) {
		this.#root = root;
		this.#isGit = isGit;
		this.#trackedFiles = trackedFiles;
		this.#dbFiles = dbFiles;
	}

	static async open(path, dbFiles = new Set()) {
		const detectedRoot = await GitProvider.detectRoot(path);
		const isGit = detectedRoot !== null;

		// Reuse cached context if HEAD hasn't changed
		if (isGit) {
			const headHash = await GitProvider.getHeadHash(detectedRoot);
			const cached = cache.get(path);
			if (cached && cached.headHash === headHash) {
				return new ProjectContext(path, true, cached.trackedFiles, dbFiles);
			}

			const allTracked = await GitProvider.getTrackedFiles(detectedRoot);
			const trackedFiles = new Set();
			for (const f of allTracked) {
				const fullF = join(detectedRoot, f);
				const relToProject = relative(path, fullF);
				if (!relToProject.startsWith("..") && !isAbsolute(relToProject)) {
					trackedFiles.add(relToProject);
				}
			}

			cache.set(path, { headHash, trackedFiles });
			return new ProjectContext(path, true, trackedFiles, dbFiles);
		}

		return new ProjectContext(path, false, new Set(), dbFiles);
	}

	async isInProject(relPath) {
		if (this.#dbFiles.has(relPath)) return true;
		if (this.#isGit && this.#trackedFiles.has(relPath)) return true;
		return false;
	}

	get root() {
		return this.#root;
	}

	get isGit() {
		return this.#isGit;
	}

	async getMappableFiles() {
		const all = new Set();

		if (this.#isGit) {
			for (const f of this.#trackedFiles) all.add(f);
		}

		for (const path of this.#dbFiles) {
			all.add(path);
		}

		return Array.from(all);
	}
}
