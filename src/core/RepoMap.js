import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import SymbolExtractor from "./SymbolExtractor.js";

export default class RepoMap {
	#ctx;
	#db;
	#projectId;
	#hdExtractor;

	constructor(projectContext, db, projectId) {
		this.#ctx = projectContext;
		this.#db = db;
		this.#projectId = projectId;
		this.#hdExtractor = new SymbolExtractor();
	}

	/**
	 * Pass 1: Build/Update the Global Tag Index (Persistent Data).
	 * This only contains definitions.
	 */
	async updateIndex() {
		const mappableFiles = await this.#ctx.getMappableFiles();
		const ctagsQueue = [];

		for (const relPath of mappableFiles) {
			const fullPath = join(this.#ctx.root, relPath);
			let content;
			let size;
			try {
				content = readFileSync(fullPath, "utf8");
				size = content.length;
			} catch {
				continue;
			}

			const hash = crypto.createHash("sha256").update(content).digest("hex");

			// Check if we need to re-index
			const existing = await this.#db.get_repo_map_file.get({
				project_id: this.#projectId,
				path: relPath,
			});

			if (existing && existing.hash === hash) {
				continue;
			}

			const ext = extname(relPath).slice(1);
			const extraction = this.#hdExtractor.extract(content, ext);

			if (extraction) {
				const { id: fileId } = await this.#db.upsert_repo_map_file.get({
					project_id: this.#projectId,
					path: relPath,
					hash,
					size,
				});

				await this.#db.clear_repo_map_file_data.run({ file_id: fileId });

				for (const sym of extraction.definitions) {
					await this.#db.insert_repo_map_tag.run({
						file_id: fileId,
						name: sym.name,
						type: sym.type,
						params: sym.params || null,
						line: sym.line,
						source: "hd",
					});
				}

				for (const ref of extraction.references) {
					await this.#db.insert_repo_map_ref.run({
						file_id: fileId,
						symbol_name: ref,
					});
				}
			} else {
				ctagsQueue.push(relPath);
			}
		}

		if (ctagsQueue.length > 0) {
			const ctagsResults = this.#generateCtags(ctagsQueue);
			for (const result of ctagsResults) {
				let size = 0;
				try {
					size = readFileSync(join(this.#ctx.root, result.path)).length;
				} catch {
					/* ignore */
				}

				const { id: fileId } = await this.#db.upsert_repo_map_file.get({
					project_id: this.#projectId,
					path: result.path,
					hash: null,
					size,
				});
				await this.#db.clear_repo_map_file_data.run({ file_id: fileId });
				for (const sym of result.symbols) {
					await this.#db.insert_repo_map_tag.run({
						file_id: fileId,
						name: sym.name,
						type: sym.type,
						params: null,
						line: sym.line,
						source: "standard",
					});
				}
			}
		}
	}

	/**
	 * Pass 2: Render a Dynamic Perspective (Session Logic).
	 * Applies the "Hot/Cold" lens and prunes to fit token budgets.
	 * @param {string[]} activeFiles - Files currently in the Agent context.
	 * @param {Object} options - { maxTokens, contextSize, maxRepoPercent }
	 * @returns {Promise<Object>} - The context-aware RepoMap.
	 */
	async renderPerspective(activeFiles = [], options = {}) {
		const globalReferences = new Set();
		let budget = options.maxTokens || 4096; // Default 4k tokens

		if (options.contextSize && options.maxRepoPercent) {
			budget = Math.floor(options.contextSize * (options.maxRepoPercent / 100));
		}

		// 1. Extract references from Active Files
		for (const relPath of activeFiles) {
			const refs = await this.#db.get_file_references.all({
				project_id: this.#projectId,
				path: relPath,
			});
			for (const r of refs) globalReferences.add(r.symbol_name);
		}

		// 2. Load all symbols for the project
		const allTags = await this.#db.get_project_repo_map.all({
			project_id: this.#projectId,
		});

		// Group tags by file
		const filesMap = new Map();
		for (const tag of allTags) {
			if (!filesMap.has(tag.path)) {
				filesMap.set(tag.path, {
					path: tag.path,
					size: tag.size,
					symbols: [],
					source: tag.source,
				});
			}
			if (tag.name) {
				filesMap.get(tag.path).symbols.push({
					name: tag.name,
					type: tag.type,
					params: tag.params,
					line: tag.line,
				});
			}
		}

		// 3. Score and Sort files by relevance
		const files = Array.from(filesMap.values())
			.map((entry) => {
				const isActive = activeFiles.includes(entry.path);
				const isReferenced = entry.symbols.some((s) =>
					globalReferences.has(s.name),
				);
				const isHot = isActive || isReferenced;

				const processedSymbols = entry.symbols.map((s) => {
					if (isHot) return s;
					const { params, line, ...cold } = s;
					return cold;
				});

				// Rank for budgeting: Active (2) > Hot (1) > Cold (0)
				const rank = isActive ? 2 : isReferenced ? 1 : 0;

				return {
					path: entry.path,
					size: entry.size,
					mode: isHot ? "hot" : "cold",
					symbols: processedSymbols,
					source: entry.source,
					rank,
				};
			})
			.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));

		// 4. Prune to fit budget (4 chars = 1 token heuristic)
		const pruned = [];
		let currentTokens = 0;

		for (const file of files) {
			// Estimate token cost for this file's entry in the map
			let estChars = file.path.length + 20;
			for (const s of file.symbols) {
				estChars += s.name.length + (s.params ? s.params.length : 0) + 5;
			}
			const estTokens = Math.ceil(estChars / 4);

			if (currentTokens + estTokens > budget && file.rank === 0) {
				continue;
			}

			pruned.push(file);
			currentTokens += estTokens;
		}

		return {
			files: pruned,
			usage: {
				tokens: currentTokens,
				budget,
			},
		};
	}

	#generateCtags(paths) {
		const result = spawnSync(
			"ctags",
			["--output-format=json", "--fields=+n", "-f", "-", ...paths],
			{ cwd: this.#ctx.root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
		);

		if (result.status !== 0) return [];

		const tags = result.stdout
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const grouped = new Map();
		for (const path of paths) grouped.set(path, []);

		for (const tag of tags) {
			const symbols = grouped.get(tag.path);
			if (symbols) {
				symbols.push({
					name: tag.name,
					type: tag.kind,
					line: tag.line,
					source: "standard",
				});
			}
		}

		return Array.from(grouped.entries()).map(([path, symbols]) => ({
			path,
			symbols,
			source: "standard",
		}));
	}
}
