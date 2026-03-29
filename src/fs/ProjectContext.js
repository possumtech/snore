import { isAbsolute, join, relative } from "node:path";
import GitProvider from "./GitProvider.js";

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
		const root = path;
		const isGit = detectedRoot !== null;

		const trackedFiles = new Set();
		if (isGit) {
			const allTracked = await GitProvider.getTrackedFiles(detectedRoot);

			for (const f of allTracked) {
				const fullF = join(detectedRoot, f);
				const relToProject = relative(root, fullF);

				if (!relToProject.startsWith("..") && !isAbsolute(relToProject)) {
					trackedFiles.add(relToProject);
				}
			}
		}

		return new ProjectContext(root, isGit, trackedFiles, dbFiles);
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
