import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { getEncoding } from "js-tiktoken";
import SymbolExtractor from "./SymbolExtractor.js";

export default class RepoMap {
	#ctx;
	#db;
	#projectId;
	#hdExtractor;
	#tokenizer;

	constructor(projectContext, db, projectId) {
		this.#ctx = projectContext;
		this.#db = db;
		this.#projectId = projectId;
		this.#hdExtractor = new SymbolExtractor();
		this.#tokenizer = getEncoding("cl100k_base");
	}

	async updateIndex() {
		const mappableFiles = await this.#ctx.getMappableFiles();
		const ctagsQueue = [];

		for (const relPath of mappableFiles) {
			const fullPath = join(this.#ctx.root, relPath);

			// Gracefully skip files that exist in Git/VisibilityMap but are missing on disk
			if (!existsSync(fullPath)) continue;

			const content = readFileSync(fullPath, "utf8");
			const size = content.length;
			const hash = crypto.createHash("sha256").update(content).digest("hex");
			const visibility = await this.#ctx.resolveState(relPath);

			const existing = await this.#db.get_repo_map_file.get({
				project_id: this.#projectId,
				path: relPath,
			});

			if (existing?.hash === hash && existing?.visibility === visibility)
				continue;

			// Always upsert the file record so it exists in the map even without symbols
			const { id: fileId } = await this.#db.upsert_repo_map_file.get({
				project_id: this.#projectId,
				path: relPath,
				hash,
				size,
				visibility,
			});

			await this.#db.clear_repo_map_file_data.run({ file_id: fileId });

			const ext = extname(relPath).slice(1);
			const extraction = this.#hdExtractor.extract(content, ext);

			if (extraction) {
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
				const fullPath = join(this.#ctx.root, result.path);
				if (!existsSync(fullPath)) continue;

				const size = readFileSync(fullPath).length;
				const visibility = await this.#ctx.resolveState(result.path);

				const { id: fileId } = await this.#db.upsert_repo_map_file.get({
					project_id: this.#projectId,
					path: result.path,
					hash: null,
					size,
					visibility,
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

	async renderPerspective(activeFiles = [], options = {}) {
		const globalReferences = new Set();
		let budget = Number.parseInt(
			process.env.RUMMY_MAP_TOKEN_BUDGET || "4096",
			10,
		);

		if (options.contextSize && process.env.RUMMY_MAP_MAX_PERCENT) {
			const percent = Number.parseInt(process.env.RUMMY_MAP_MAX_PERCENT, 10);
			budget = Math.floor(options.contextSize * (percent / 100));
		}

		// Normalize active file paths to be relative to project root
		const normalizedActiveFiles = activeFiles.map((f) =>
			relative(this.#ctx.root, join(this.#ctx.root, f)),
		);

		// 1. Identify all symbols referenced in the active context
		for (const relPath of normalizedActiveFiles) {
			const refs = await this.#db.get_file_references.all({
				project_id: this.#projectId,
				path: relPath,
			});
			for (const r of refs) globalReferences.add(r.symbol_name);
		}

		// 2. Load all project tags and map them
		const allTags = await this.#db.get_project_repo_map.all({
			project_id: this.#projectId,
		});
		const filesMap = new Map();
		for (const tag of allTags) {
			if (tag.visibility === "invisible") continue;

			if (!filesMap.has(tag.path)) {
				filesMap.set(tag.path, {
					path: tag.path,
					visibility: tag.visibility || "mappable",
					symbols: [],
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

		const activeDirs = new Set(normalizedActiveFiles.map((f) => dirname(f)));

		// 3. Score and Categorize Files
		const processedFiles = Array.from(filesMap.values()).map((file) => {
			const status = normalizedActiveFiles.includes(file.path)
				? "active"
				: file.visibility;

			// Relevance Heuristic
			const overlapCount = file.symbols.filter((s) =>
				globalReferences.has(s.name),
			).length;
			const isInActiveDir = activeDirs.has(dirname(file.path));

			let rank = 0;
			if (status === "active") {
				rank = 100000; // Always top
			} else {
				// Significant boost for directory proximity (1000 pts)
				// + symbol overlap (10 pts per symbol)
				// + small boost for read_only (100 pts)
				rank = (isInActiveDir ? 1000 : 0) + 
				       (status === "read_only" ? 100 : 0) +
				       overlapCount * 10;
			}

			return { ...file, status, rank, overlapCount };
		});

		// Sort by rank (relevance)
		const sorted = processedFiles.sort(
			(a, b) => b.rank - a.rank || a.path.localeCompare(b.path),
		);

		const finalFiles = [];
		let currentTokens = 0;

		// 4. Adaptive Detail Selection ("The Squish")
		for (const file of sorted) {
			if (file.status === "ignored") continue;

			let displayFile;

			if (file.status === "active") {
				// FULL CONTENT for Active only
				const fullPath = join(this.#ctx.root, file.path);
				let content = "";
				try {
					content = readFileSync(fullPath, "utf8");
				} catch (err) {
					content = `Error reading file: ${err.message}`;
				}
				displayFile = {
					path: file.path,
					status: file.status,
					content,
				};
			} else {
				// MAPPED files start with full detail (Signatures)
				displayFile = {
					path: file.path,
					status: file.status,
					symbols: file.symbols,
				};
			}

			let estTokens = this.#tokenizer.encode(
				JSON.stringify(displayFile),
			).length;

			// If we are over budget, attempt to "Squish" before dropping
			if (currentTokens + estTokens > budget) {
				if (file.status === "active" || file.status === "read_only") {
					// Mandatory context - we keep active files even if they blow the budget
				} else if (file.status === "mapped") {
					// Tier 1 Squish: Detailed Symbols -> Signatures Only (No params/lines)
					const signaturesOnly = {
						path: file.path,
						status: file.status,
						symbols: file.symbols.map((s) => ({ name: s.name, type: s.type })),
					};
					const sigTokens = this.#tokenizer.encode(
						JSON.stringify(signaturesOnly),
					).length;

					if (currentTokens + sigTokens <= budget) {
						displayFile = signaturesOnly;
						estTokens = sigTokens;
					} else {
						// Tier 2 Squish: Signatures -> Breadcrumbs (Path only)
						const pathOnly = { path: file.path, status: file.status };
						const pathTokens = this.#tokenizer.encode(
							JSON.stringify(pathOnly),
						).length;

						if (currentTokens + pathTokens <= budget) {
							displayFile = pathOnly;
							estTokens = pathTokens;
						} else {
							// For cold/mapped files over budget, we skip them entirely
							continue;
						}
					}
				} else {
					continue; // Skip ignored or other types
				}
			}

			finalFiles.push(displayFile);
			currentTokens += estTokens;
		}

		return {
			files: finalFiles,
			usage: { tokens: currentTokens, budget },
		};
	}

	#generateCtags(paths) {
		const result = spawnSync(
			"ctags",
			["--output-format=json", "--fields=+n", "-f", "-", ...paths],
			{ cwd: this.#ctx.root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
		);

		if (result.error && result.error.code === "ENOENT") {
			console.warn("[RUMMY] skipping ctags: not installed.");
			const empty = new Map();
			for (const p of paths) empty.set(p, []);
			return empty;
		}

		if (result.status !== 0) {
			console.warn(`[RUMMY] skipping ctags: failed (${result.stderr})`);
			const empty = new Map();
			for (const p of paths) empty.set(p, []);
			return empty;
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

	#estimateTokens(file, status) {
		if (status === "active") {
			const fullPath = join(this.#ctx.root, file.path);
			try {
				const content = readFileSync(fullPath, "utf8");
				return Math.ceil(content.length / 4) + 20;
			} catch (_err) {
				return 20;
			}
		}
		return file.path.length / 4 + (file.symbols?.length || 0) * 15 + 10;
	}
}
