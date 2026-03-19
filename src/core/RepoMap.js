import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
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

			if (!existsSync(fullPath)) continue;

			const content = readFileSync(fullPath, "utf8");
			const size = content.length;
			const hash = crypto.createHash("sha256").update(content).digest("hex");
			const visibility = await this.#ctx.resolveState(relPath);

			const existing = fileRecords.get(relPath);

			if (
				existing?.hash === hash &&
				existing?.visibility === visibility &&
				fileTagCounts.get(relPath) > 0
			) {
				continue;
			}

			const { id: fileId } = await this.#db.upsert_repo_map_file.get({
				project_id: this.#projectId,
				path: relPath,
				hash,
				size,
				visibility,
				symbol_tokens: 0,
			});

			await this.#db.clear_repo_map_file_data.run({ file_id: fileId });

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

				await this.#db.upsert_repo_map_file.run({
					project_id: this.#projectId,
					path: relPath,
					hash,
					size,
					visibility,
					symbol_tokens: symbolWeight,
				});

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
			} else {
				const breadcrumbWeight = this.#tokenizer.encode(
					JSON.stringify({ path: relPath, status: visibility }),
				).length;

				await this.#db.upsert_repo_map_file.run({
					project_id: this.#projectId,
					path: relPath,
					hash,
					size,
					visibility,
					symbol_tokens: breadcrumbWeight,
				});
				ctagsQueue.Spush(relPath);
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
					JSON.stringify({ path, status: visibility, symbols }),
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
						params: sym.params || null,
						line: sym.line,
						source: "standard",
					});
				}
			}
		}
	}

	async renderPerspective(activeFiles = [], options = {}) {
		let budget = Number.parseInt(
			process.env.RUMMY_MAP_TOKEN_BUDGET || "16384",
			10,
		);

		if (options.contextSize && process.env.RUMMY_MAP_MAX_PERCENT) {
			const percent = Number.parseInt(process.env.RUMMY_MAP_MAX_PERCENT, 10);
			budget = Math.floor(options.contextSize * (percent / 100));
		}

		const normalizedActiveFiles = activeFiles.map((f) => {
			const full = isAbsolute(f) ? f : join(this.#ctx.root, f);
			return relative(this.#ctx.root, full);
		});

		const activeWords = new Set();
		for (const relPath of normalizedActiveFiles) {
			const fullPath = join(this.#ctx.root, relPath);
			if (existsSync(fullPath)) {
				const content = readFileSync(fullPath, "utf8");
				const words = content.match(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g) || [];
				for (const w of words) activeWords.add(w);
			}
		}

		const allFiles = await this.#db.get_project_repo_map.all({
			project_id: this.#projectId,
		});

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

		const processedFiles = Array.from(filesMap.values()).map((file) => {
			const status = normalizedActiveFiles.includes(file.path)
				? "active"
				const isRootFile = !file.path.includes("/");

			let rank = 0;
			if (status === "active") {
				rank = Infinity; // Active is always top priority
			} else if (isRootFile) {
				rank = 1 + overlapCount; // Root files are warm by default (rank 1+)
			} else {
				rank = overlapCount; // Other files ranked by overlap count
			}

			return { ...file, status, rank };
		});

		const sorted = processedFiles.sort(
			(a, b) => b.rank - a.rank || a.path.localeCompare(b.path),
		);

		const finalFiles = [];
		let currentTokens = 0;

		for (const file of sorted) {
			if (file.status === "ignored") continue;

			let displayFile;

			if (file.status === "active") {
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

				finalFiles.push(displayFile);
				currentTokens += this.#tokenizer.encode(JSON.stringify(displayFile)).length;
				continue;
			}

			displayFile = {
				path: file.path,
				size: file.size,
				status: file.status,
				symbols: file.symbols,
			};

			if (file.symbols.length === 0) {
				displayFile = { path: file.path, size: file.size, status: file.status };
			}

			let finalTokens = file.symbol_tokens || this.#tokenizer.encode(JSON.stringify(displayFile)).length;
			
			// Only squish files with rank 0 if over budget
			if (currentTokens + finalTokens > budget && file.rank === 0) {
				if (file.symbols.length > 0) {
					const signaturesOnly = {
						path: file.path,
						size: file.size,
						status: file.status,
						symbols: file.symbols.map((s) => ({ name: s.name })),
					};
					const sigTokens = this.#tokenizer.encode(JSON.stringify(signaturesOnly)).length;

					if (currentTokens + sigTokens <= budget) {
						displayFile = signaturesOnly;
						finalTokens = sigTokens;
					} else {
						const pathOnly = { path: file.path, size: file.size, status: file.status };
						const pathTokens = this.#tokenizer.encode(JSON.stringify(pathOnly)).length;

						if (currentTokens + pathTokens <= budget) {
							displayFile = pathOnly;
							finalTokens = pathTokens;
						} else {
							continue;
						}
					}
				} else {
					continue;
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
			["--output-format=json", "--fields=+nS", "-f", "-", ...paths],
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
			.split("
")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const grouped = new Map();
		for (const path of paths) grouped.set(path, []);

		for (const tag of tags) {
			const symbols = grouped.get(tag.path);
			if (symbols) {
				let params = tag.signature || null;

				if (!params && tag.path.endsWith(".lua") && tag.pattern && tag.name) {
					const escapedName = tag.name.replace(/[.*+?^${}()|[\]\]/g, "\$&");
					const regex = new RegExp(`${escapedName}\s*(\(.*?\))`);
					const match = tag.pattern.match(regex);
					if (match) {
						params = match[1];
					}
				}

				symbols.push({
					name: tag.name,
					type: tag.kind,
					params,
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
