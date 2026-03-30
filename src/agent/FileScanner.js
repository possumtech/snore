import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
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
	const sorted = symbols.toSorted((a, b) => (a.line || 0) - (b.line || 0));
	const stack = [];
	const lines = [];

	for (const s of sorted) {
		while (stack.length > 0 && s.line > stack.at(-1).endLine) stack.pop();
		const depth = stack.length;
		const indent = "  ".repeat(depth);
		const kind = s.kind ? `${s.kind} ` : "";
		const line = s.line ? ` L${s.line}` : "";
		const p = s.params
			? `(${Array.isArray(s.params) ? s.params.join(", ") : s.params})`
			: "";
		lines.push(`${indent}${kind}${s.name}${p}${line}`);
		if (s.endLine && s.endLine > s.line) stack.push(s);
	}

	return lines.join("\n");
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
	 * Uses filesystem mtime to skip unchanged files (no read, no hash).
	 */
	async scan(projectPath, projectId, mappableFiles, currentTurn = 0) {
		const activeRuns = await this.#db.get_active_runs.all({
			project_id: projectId,
		});
		if (activeRuns.length === 0) return;

		// Stat all files concurrently (no content reads)
		const diskStats = new Map();
		const statResults = await Promise.all(
			mappableFiles.map(async (relPath) => {
				const fullPath = join(projectPath, relPath);
				try {
					const stat = await fs.stat(fullPath);
					if (!stat.isFile()) return null;
					return { relPath, mtime: stat.mtimeMs, fullPath };
				} catch {
					return null;
				}
			}),
		);
		for (const entry of statResults) {
			if (entry) diskStats.set(entry.relPath, { mtime: entry.mtime, fullPath: entry.fullPath });
		}

		for (const run of activeRuns) {
			await this.#syncRun(run.id, projectPath, diskStats, currentTurn);
		}
	}

	async #syncRun(runId, projectPath, diskStats, currentTurn) {
		const existing = await this.#knownStore.getFileEntries(runId);
		const fileKeys = new Map();
		for (const entry of existing) {
			fileKeys.set(entry.key, entry);
		}

		const changedPaths = [];

		for (const [relPath, { mtime, fullPath }] of diskStats) {
			const entry = fileKeys.get(relPath);
			fileKeys.delete(relPath);

			// Skip if mtime hasn't changed since last scan
			const storedMtime = entry?.updated_at
				? new Date(entry.updated_at).getTime()
				: 0;
			if (entry && Math.abs(mtime - storedMtime) < 1000) continue;

			// mtime changed — read and hash
			let content;
			try {
				content = readFileSync(fullPath, "utf8");
			} catch {
				continue;
			}
			const hash = hashContent(content);

			// Skip if hash matches (mtime changed but content didn't)
			if (entry?.hash === hash) continue;

			changedPaths.push(relPath);

			const isRoot = !relPath.includes("/");
			const turn = isRoot ? currentTurn : entry?.turn || 0;

			await this.#knownStore.upsert(
				runId,
				turn,
				relPath,
				content,
				entry?.state || "full",
				{
					hash,
					updatedAt: new Date(mtime).toISOString(),
				},
			);
		}

		// Extract symbols for changed files
		if (changedPaths.length > 0) {
			const symbolMap = await this.#extractAllSymbols(
				projectPath,
				changedPaths,
			);
			for (const [relPath, symbols] of symbolMap) {
				const symbolText = formatSymbols(symbols);
				if (!symbolText) continue;
				// Update meta with symbols (don't overwrite value or state)
				const current = await this.#knownStore.getValue(runId, relPath);
				if (current !== null) {
					await this.#knownStore.upsert(
						runId,
						currentTurn,
						relPath,
						current,
						"full",
						{ meta: { symbols: symbolText } },
					);
				}
			}
		}

		// New files that aren't in the store yet
		for (const [relPath, { mtime, fullPath }] of diskStats) {
			if (fileKeys.has(relPath)) continue;
			const alreadyProcessed = changedPaths.includes(relPath);
			if (alreadyProcessed) continue;

			// Check if it was already handled above (existed + unchanged)
			const entry = existing.find((e) => e.key === relPath);
			if (entry) continue;

			// Truly new file
			let content;
			try {
				content = readFileSync(fullPath, "utf8");
			} catch {
				continue;
			}
			const isRoot = !relPath.includes("/");
			await this.#knownStore.upsert(
				runId,
				isRoot ? currentTurn : 0,
				relPath,
				content,
				"full",
				{
					hash: hashContent(content),
					updatedAt: new Date(mtime).toISOString(),
				},
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
					const symbols = await antlrmap.mapSource(content, ext);
					if (symbols?.length > 0) {
						symbolMap.set(relPath, symbols);
						continue;
					}
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
