import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import CtagsExtractor from "./CtagsExtractor.js";

let Antlrmap = null;
let antlrmapSupported = null;
try {
	Antlrmap = (await import("@possumtech/antlrmap")).default;
	antlrmapSupported = new Set(Object.keys(Antlrmap.extensions));
} catch {
	// antlrmap not installed — ctags only
}

function hashContent(content) {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function formatSymbols(symbols) {
	return symbols
		.map((s) => (s.params ? `${s.name}(${s.params})` : s.name))
		.join("\n");
}

export default class FileScanner {
	#knownStore;
	#db;

	constructor(knownStore, db) {
		this.#knownStore = knownStore;
		this.#db = db;
	}

	/**
	 * Scan the project and sync file entries across all active runs.
	 * - value = always full file content
	 * - meta.symbols = always extracted symbols (when available)
	 * - Root files promoted to currentTurn (visible to model on turn 1)
	 */
	async scan(projectPath, projectId, mappableFiles, currentTurn = 0) {
		const activeRuns = await this.#db.get_active_runs.all({
			project_id: projectId,
		});
		if (activeRuns.length === 0) return;

		// Read all files from disk
		const diskFiles = new Map();
		for (const relPath of mappableFiles) {
			const fullPath = join(projectPath, relPath);
			if (!existsSync(fullPath)) continue;
			try {
				const content = readFileSync(fullPath, "utf8");
				diskFiles.set(relPath, { content, hash: hashContent(content) });
			} catch {
				// Binary or unreadable
			}
		}

		// Extract symbols for all files
		const symbolMap = await this.#extractAllSymbols(projectPath, [
			...diskFiles.keys(),
		]);

		for (const run of activeRuns) {
			await this.#syncRun(run.id, diskFiles, symbolMap, currentTurn);
		}
	}

	async #syncRun(runId, diskFiles, symbolMap, currentTurn) {
		const existing = await this.#knownStore.getFileEntries(runId);
		const fileKeys = new Map();
		for (const entry of existing) {
			fileKeys.set(entry.key, entry);
		}

		for (const [relPath, { content, hash }] of diskFiles) {
			const entry = fileKeys.get(relPath);
			fileKeys.delete(relPath);

			// Skip unchanged files
			if (entry?.hash === hash) continue;

			// Determine turn: root files get promoted, others start at 0
			const isRoot = !relPath.includes("/");
			const turn = isRoot ? currentTurn : entry?.turn || 0;

			// Symbols go in meta, full content always goes in value
			const symbols = symbolMap.get(relPath);
			const symbolText = symbols ? formatSymbols(symbols) : "";
			const meta = symbolText ? { symbols: symbolText } : null;

			await this.#knownStore.upsert(
				runId,
				turn,
				relPath,
				content,
				entry?.state || "full",
				{ hash, meta },
			);
		}

		// Remove files deleted from disk
		for (const [relPath] of fileKeys) {
			await this.#knownStore.remove(runId, relPath);
		}
	}

	async #extractAllSymbols(projectPath, paths) {
		const symbolMap = new Map();
		const ctagsQueue = [];
		const antlrmap = Antlrmap ? new Antlrmap() : null;

		for (const relPath of paths) {
			const ext = extname(relPath);
			if (antlrmap && antlrmapSupported?.has(ext)) {
				try {
					const content = readFileSync(join(projectPath, relPath), "utf8");
					const symbols = antlrmap.extract(content, ext);
					symbolMap.set(relPath, symbols);
					continue;
				} catch {
					// Fall through to ctags
				}
			}
			ctagsQueue.push(relPath);
		}

		if (ctagsQueue.length > 0) {
			const ctagsExtractor = new CtagsExtractor(projectPath);
			const results = ctagsExtractor.extract(ctagsQueue);
			for (const [path, symbols] of results) {
				if (symbols.length > 0) symbolMap.set(path, symbols);
			}
		}

		return symbolMap;
	}
}
