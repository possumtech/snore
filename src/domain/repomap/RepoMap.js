import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { getEncoding } from "js-tiktoken";
import CtagsExtractor from "../../extraction/CtagsExtractor.js";
import SymbolExtractor from "../../extraction/SymbolExtractor.js";

/**
 * RepoMap coordinates the persistent indexing of project symbols
 * and the generation of context-aware repository perspectives.
 */
export default class RepoMap {
	#ctx;
	#db;
	#projectId;
	#hdExtractor;
	#ctagsExtractor;
	#tokenizer;

	constructor(projectContext, db, projectId) {
		this.#ctx = projectContext;
		this.#db = db;
		this.#projectId = projectId;
		this.#hdExtractor = new SymbolExtractor();
		this.#ctagsExtractor = new CtagsExtractor(projectContext.root);
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

		// Fetch handlers from DB
		const handlersRows = await this.#db.get_file_type_handlers.all();
		const handlers = new Map();
		for (const row of handlersRows) {
			handlers.set(row.extension, row.extractor);
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
			const extractorType = handlers.get(ext);

			if (!extractorType) {
				// No handler means no extraction needed (e.g. .txt files)
				continue;
			}

			if (extractorType === "hd") {
				const extraction = this.#hdExtractor.extract(content, ext);

				if (extraction) {
					const symbolWeight = this.#tokenizer.encode(
						JSON.stringify({
							path: relPath,
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

					for (const ref of extraction.references) {
						await this.#db.insert_repo_map_ref.run({
							file_id: fileId,
							symbol_name: ref,
						});
					}
				} else {
					ctagsQueue.push(relPath);
				}
			} else if (extractorType === "ctags") {
				ctagsQueue.push(relPath);
			}
		}

		if (ctagsQueue.length > 0) {
			const ctagsResults = this.#ctagsExtractor.extract(ctagsQueue);
			for (const [path, symbols] of ctagsResults.entries()) {
				const fullPath = join(this.#ctx.root, path);
				if (!existsSync(fullPath)) continue;

				const size = readFileSync(fullPath).length;
				const visibility = await this.#ctx.resolveState(path);
				const symbolWeight = this.#tokenizer.encode(
					JSON.stringify({ path, symbols }),
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

	async renderPerspective(options = {}) {
		let budget = Number.parseInt(
			process.env.RUMMY_MAP_TOKEN_BUDGET || "16384",
			10,
		);

		if (options.contextSize && process.env.RUMMY_MAP_MAX_PERCENT) {
			const percent = Number.parseInt(process.env.RUMMY_MAP_MAX_PERCENT, 10);
			budget = Math.floor(options.contextSize * (percent / 100));
		}

		// RANKING IS NOW ENTIRELY SQL-DRIVEN
		const rankedFiles = await this.#db.get_ranked_repo_map.all({
			project_id: this.#projectId,
		});

		// Hydrate with symbols from the existing mapping.js logic (colocated data)
		const allTags = await this.#db.get_project_repo_map.all({
			project_id: this.#projectId,
		});
		const tagMap = new Map();
		for (const row of allTags) {
			if (!tagMap.has(row.path)) tagMap.set(row.path, []);
			if (row.name) {
				tagMap.get(row.path).push({
					name: row.name,
					type: row.type,
					params: row.params,
					line: row.line,
				});
			}
		}

		const finalFiles = [];
		let currentTokens = 0;
		const currentTurn = options.sequence ?? 0;
		const decayThreshold = Number.parseInt(
			process.env.RUMMY_DECAY_THRESHOLD || "12",
			10,
		);

		for (const file of rankedFiles) {
			if (file.visibility === "ignored") continue;

			let displayFile;

			// FIDELITY DECAY: Full content ONLY for:
			// 1. User-buffered files (pinned)
			// 2. Retained files with attention within the last X turns
			const hasRecentAttention =
				currentTurn - file.last_attention_turn <= decayThreshold;
			const shouldIncludeSource =
				file.is_buffered || (file.is_active && hasRecentAttention);

			if (shouldIncludeSource) {
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
					content,
				};

				const weight = this.#tokenizer.encode(
					JSON.stringify(displayFile),
				).length;
				finalFiles.push(displayFile);
				currentTokens += weight;
				continue;
			}

			const symbols = tagMap.get(file.path) || [];
			displayFile = {
				path: file.path,
				size: file.size,
				symbols,
			};

			if (symbols.length === 0) {
				displayFile = { path: file.path, size: file.size };
			}

			let finalTokens =
				file.symbol_tokens ||
				this.#tokenizer.encode(JSON.stringify(displayFile)).length;

			if (currentTokens + finalTokens > budget) {
				if (symbols.length > 0) {
					const signaturesOnly = {
						path: file.path,
						size: file.size,
						symbols: symbols.map((s) => ({ name: s.name })),
					};
					const sigTokens = this.#tokenizer.encode(
						JSON.stringify(signaturesOnly),
					).length;

					if (currentTokens + sigTokens <= budget) {
						displayFile = signaturesOnly;
						finalTokens = sigTokens;
					} else {
						const pathOnly = {
							path: file.path,
							size: file.size,
						};
						const pathTokens = this.#tokenizer.encode(
							JSON.stringify(pathOnly),
						).length;

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
			displayFile.heat = file.heat;
			finalFiles.push(displayFile);
			currentTokens += finalTokens;
		}

		return {
			files: finalFiles,
			usage: { tokens: currentTokens, budget },
		};
	}
}
