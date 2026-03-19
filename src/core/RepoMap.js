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

		const allFilesRows = await this.#db.get_project_repo_map.all({
			project_id: this.#projectId,
		});
		const fileTagCounts = new Map();
		const fileRecords = new Map();
		for (const row of allFilesRows) {
			if (!fileRecords.has(row.path)) {
				fileRecords.set(row.path, {
					hash: row.hash,
					visibility: row.visibility,
					id: row.id,
				});
			}
			if (row.name) {
				fileTagCounts.set(row.path, (fileTagCounts.get(row.path) || 0) + 1);
			}
		}

		for (const relPath of mappableFiles) {
			const fullPath = join(this.#ctx.root, relPath);

			// Gracefully skip files that exist in Git/VisibilityMap but are missing on disk
			if (!existsSync(fullPath)) continue;

			const content = readFileSync(fullPath, "utf8");
			const size = content.length;
			const hash = crypto.createHash("sha256").update(content).digest("hex");
			const visibility = await this.#ctx.resolveState(relPath);

			const existing = fileRecords.get(relPath);

			// Skip if hash/visibility match AND we have at least some tags (if symbols exist)
			// We don't skip if tag count is 0 because it might be a previous failed index.
			if (
				existing?.hash === hash &&
				existing?.visibility === visibility &&
				fileTagCounts.get(relPath) > 0
			) {
				continue;
			}

			const ext = extname(relPath).slice(1);
			const extraction = this.#hdExtractor.extract(content, ext);

			if (extraction) {
				const symbolWeight = this.#tokenizer.encode(
					JSON.stringify({
						path: relPath,
						status: visibility,
						symbols: extraction.definitions,
					}),
				).length;

				const { id: fileId } = await this.#db.upsert_repo_map_file.get({
					project_id: this.#projectId,
					path: relPath,
					hash,
					size,
					visibility,
					symbol_tokens: symbolWeight,
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
				// Mark as indexed with 0 symbols for now so we don't infinitely re-index
				// if ctags also finds nothing.
				const breadcrumbWeight = this.#tokenizer.encode(
					JSON.stringify({
						path: relPath,
						status: visibility,
					}),
				).length;

				await this.#db.upsert_repo_map_file.run({
					project_id: this.#projectId,
					path: relPath,
					hash,
					size,
					visibility,
					symbol_tokens: breadcrumbWeight,
				});
				ctagsQueue.push(relPath);
			}
		}

		if (ctagsQueue.length > 0) {
			const ctagsResults = this.#generateCtags(ctagsQueue);
			for (const result of ctagsResults) {
				const { path, symbols } = result;
				const fullPath = join(this.#ctx.root, path);
				if (!existsSync(fullPath)) continue;

				const size = readFileSync(fullPath).length;
				const visibility = await this.#ctx.resolveState(path);
				const symbolWeight = this.#tokenizer.encode(
					JSON.stringify({
						path,
						status: visibility,
						symbols,
					}),
				).length;

				const { id: fileId } = await this.#db.upsert_repo_map_file.get({
					project_id: this.#projectId,
					path: path,
					hash: null,
					size,
					visibility,
					symbol_tokens: symbolWeight,
				});
				await this.#db.clear_repo_map_file_data.run({ file_id: fileId });
				for (const sym of symbols) {
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
			process.env.RUMMY_MAP_TOKEN_BUDGET || "16384",
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

		// 1. Identify symbols referenced in the active context (Directed Warming)
		for (const relPath of normalizedActiveFiles) {
			const refs = await this.#db.get_file_references.all({
				project_id: this.#projectId,
				path: relPath,
			});
			for (const r of refs) globalReferences.add(r.symbol_name);
		}

		// 2. Load all project tags and map them
		const allFiles = await this.#db.get_project_repo_map.all({
			project_id: this.#projectId,
		});

		// Fallback: If no references found from active files, use global references
		// to allow the Root-Warm rule to find relevant entry points.
		if (globalReferences.size === 0) {
			const refs = await this.#db.get_project_references.all({
				project_id: this.#projectId,
			});
			for (const r of refs) globalReferences.add(r.symbol_name);
		}

		const filesMap = new Map();
		for (const row of allFiles) {
			if (row.visibility === "invisible") continue;

			if (!filesMap.has(row.path)) {
				filesMap.set(row.path, {
					path: row.path,
					size: row.size || 0,
					symbol_tokens: row.symbol_tokens || 0,
					visibility: row.visibility || "mappable",
					symbols: [],
				});
			}
			if (row.name) {
				filesMap.get(row.path).symbols.push({
					name: row.name,
					type: row.type,
					params: row.params,
					line: row.line,
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
			const isRootFile = !file.path.includes("/");
			const isInActiveDir = activeDirs.has(dirname(file.path));

			let rank = 0;
			if (status === "active") {
				rank = 100000; // Always top
			} else {
				// ROOT-WARM RULE:
				// 1. Root files get 5000 pts (Warm - show symbols)
				// 2. Directory proximity gets 1000 pts
				// 3. Symbol overlap gets 10 pts per symbol
				rank =
					(isRootFile ? 5000 : 0) +
					(isInActiveDir ? 1000 : 0) +
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
				const tokens = this.#tokenizer.encode(content).length;
				displayFile = {
					path: file.path,
					size: file.size,
					tokens,
					status: file.status,
					content,
				};

				// Mandatory context - we keep active files even if they blow the budget
				finalFiles.push(displayFile);
				currentTokens += this.#tokenizer.encode(
					JSON.stringify(displayFile),
				).length;
				continue;
			}

			// Non-active files (MAPPABLE / READ_ONLY)
			displayFile = {
				path: file.path,
				size: file.size,
				status: file.status,
				symbols: file.symbols,
			};

			// If a file has 0 symbols, it's just a breadcrumb by definition
			if (file.symbols.length === 0) {
				displayFile = { path: file.path, size: file.size, status: file.status };
			}

			// Initial weight of the file with full symbols
			let finalTokens = file.symbol_tokens || this.#tokenizer.encode(
				JSON.stringify(displayFile),
			).length;

			// If we are over budget, attempt to "Squish" before dropping.
			// ROOT-WARM EXEMPTION: We don't squish root files (rank >= 5000) because they are priority context.
			if (currentTokens + finalTokens > budget && file.rank < 5000) {
				if (file.status === "mappable" || file.status === "read_only") {
					if (file.symbols.length > 0) {
						// Tier 1 Squish: Detailed Symbols -> Signatures Only (No params/lines)
						const signaturesOnly = {
							path: file.path,
							size: file.size,
							status: file.status,
							symbols: file.symbols.map((s) => ({ name: s.name, type: s.type })),
						};
						const sigTokens = this.#tokenizer.encode(
							JSON.stringify(signaturesOnly),
						).length;

						if (currentTokens + sigTokens <= budget) {
							displayFile = signaturesOnly;
							finalTokens = sigTokens;
						} else {
							// Tier 2 Squish: Signatures -> Breadcrumbs (Path only)
							const pathOnly = {
								path: file.path,
								size: file.size,
								status: file.status,
							};
							const pathTokens = this.#tokenizer.encode(
								JSON.stringify(pathOnly),
							).length;

							if (currentTokens + pathTokens <= budget) {
								displayFile = pathOnly;
								finalTokens = pathTokens;
							} else {
								// For cold/mappable files over budget, we skip them entirely
								continue;
							}
						}
					} else {
						// File already has 0 symbols (breadcrumb), if it's over budget, skip it
						continue;
					}
				} else {
					continue; // Skip ignored or other types
				}
			}

			displayFile.tokens = finalTokens;
			finalFiles.push(displayFile);
			currentTokens += finalTokens;
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
}
