import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import CtagsExtractor from "../../extraction/CtagsExtractor.js";

const estimateTokens = (str) => Math.ceil(str.length / 4);

let Antlrmap = null;
let antlrmapSupported = null;
try {
	Antlrmap = (await import("@possumtech/antlrmap")).default;
	antlrmapSupported = new Set(Object.keys(Antlrmap.extensions));
} catch {
	// antlrmap not installed — ctags only
}

export default class RepoMap {
	#ctx;
	#db;
	#projectId;
	#antlrmap;
	#ctagsExtractor;

	constructor(projectContext, db, projectId) {
		this.#ctx = projectContext;
		this.#db = db;
		this.#projectId = projectId;
		this.#antlrmap = Antlrmap ? new Antlrmap() : null;
		this.#ctagsExtractor = new CtagsExtractor(projectContext.root);
	}

	async updateIndex() {
		const mappableFiles = await this.#ctx.getMappableFiles();

		const allFilesRows = await this.#db.get_project_repo_map.all({
			project_id: this.#projectId,
		});
		const fileTagCounts = new Map();
		const fileRecords = new Map();
		for (const row of allFilesRows) {
			if (!fileRecords.has(row.path)) {
				fileRecords.set(row.path, {
					hash: row.hash,
					id: row.id,
				});
			}
			if (row.name) {
				fileTagCounts.set(row.path, (fileTagCounts.get(row.path) || 0) + 1);
			}
		}

		const antlrQueue = [];
		const ctagsQueue = [];

		for (const relPath of mappableFiles) {
			const fullPath = join(this.#ctx.root, relPath);
			if (!existsSync(fullPath)) continue;

			const content = readFileSync(fullPath, "utf8");
			const size = content.length;
			const hash = crypto.createHash("sha256").update(content).digest("hex");

			const existing = fileRecords.get(relPath);

			if (existing?.hash === hash && fileTagCounts.get(relPath) > 0) {
				continue;
			}

			await this.#db.upsert_repo_map_file.get({
				project_id: this.#projectId,
				path: relPath,
				hash,
				size,
				symbol_tokens: 0,
			});

			// Route to antlrmap if supported, otherwise ctags
			const ext = `.${relPath.split(".").pop()}`;
			if (this.#antlrmap && antlrmapSupported?.has(ext)) {
				antlrQueue.push(relPath);
			} else {
				ctagsQueue.push(relPath);
			}
		}

		// Antlrmap extraction (per-file, so one failure doesn't tank the batch)
		if (antlrQueue.length > 0 && this.#antlrmap) {
			for (const relPath of antlrQueue) {
				try {
					const symbols = await this.#antlrmap.mapFile(
						join(this.#ctx.root, relPath),
					);
					if (!symbols || symbols.length === 0) {
						ctagsQueue.push(relPath);
						continue;
					}

					const symbolWeight = estimateTokens(
						JSON.stringify({ path: relPath, symbols }),
					);

					const { id: fileId } = await this.#db.upsert_repo_map_file.get({
						project_id: this.#projectId,
						path: relPath,
						hash: null,
						size: null,
						symbol_tokens: symbolWeight,
					});
					await this.#db.clear_repo_map_file_data.run({ file_id: fileId });
					for (const sym of symbols) {
						await this.#db.insert_repo_map_tag.run({
							file_id: fileId,
							name: sym.name,
							type: sym.kind,
							params: sym.params ? sym.params.join(", ") : null,
							line: sym.line,
							source: "antlrmap",
						});
					}
				} catch {
					ctagsQueue.push(relPath);
				}
			}
		}

		// Ctags extraction (fallback for unsupported or failed files)
		if (ctagsQueue.length > 0) {
			const ctagsResults = this.#ctagsExtractor.extract(ctagsQueue);
			for (const [path, symbols] of ctagsResults.entries()) {
				const symbolWeight = estimateTokens(JSON.stringify({ path, symbols }));

				const { id: fileId } = await this.#db.upsert_repo_map_file.get({
					project_id: this.#projectId,
					path,
					hash: null,
					size: null,
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
						source: "ctags",
					});
				}
			}
		}
	}

	#deriveFidelity(file, currentTurn, decayThreshold) {
		if (file.client_constraint === "excluded") return "excluded";
		if (file.client_constraint === "full:readonly") return "full:readonly";
		if (file.client_constraint === "full") return "full";

		if (file.has_agent_promotion) {
			const age = currentTurn - (file.last_attention_turn || 0);
			if (age <= decayThreshold) return "full";
			return "decayed";
		}

		if (file.has_editor_promotion) return "full:readonly";

		return "symbols";
	}

	async renderPerspective(options = {}) {
		const percent = Number.parseInt(
			process.env.RUMMY_MAP_MAX_PERCENT || "10",
			10,
		);
		let budget = options.contextSize
			? Math.floor(options.contextSize * (percent / 100))
			: null;

		if (process.env.RUMMY_MAP_TOKEN_BUDGET) {
			const cap = Number.parseInt(process.env.RUMMY_MAP_TOKEN_BUDGET, 10);
			budget = budget ? Math.min(budget, cap) : cap;
		}

		if (!budget)
			throw new Error(
				"Context budget unavailable. Either the model's context size could not be fetched (check your model alias) or RUMMY_MAP_TOKEN_BUDGET is not set.",
			);

		const runId = options.runId || null;

		const rankedFiles = await this.#db.get_ranked_repo_map.all({
			project_id: this.#projectId,
			run_id: runId,
		});

		const tagMap = new Map();
		const allTags = await this.#db.get_project_repo_map.all({
			project_id: this.#projectId,
			run_id: runId,
		});
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

		if (runId) {
			await this.#db.decay_agent_promotions.run({
				run_id: runId,
				current_turn: currentTurn,
				decay_threshold: decayThreshold,
			});
		}

		for (const file of rankedFiles) {
			const fidelity = this.#deriveFidelity(file, currentTurn, decayThreshold);

			if (fidelity === "excluded") continue;
			if (fidelity === "decayed") continue;

			if (fidelity === "full" || fidelity === "full:readonly") {
				const fullPath = join(this.#ctx.root, file.path);
				let content = "";
				try {
					content = readFileSync(fullPath, "utf8");
				} catch (err) {
					content = `Error reading file: ${err.message}`;
				}
				const tokens = estimateTokens(content);
				const displayFile = {
					path: file.path,
					size: file.size,
					tokens,
					content,
					fidelity,
				};

				finalFiles.push(displayFile);
				currentTokens += estimateTokens(JSON.stringify(displayFile));
				continue;
			}

			const symbols = (tagMap.get(file.path) || []).map((s) => s.name);
			let displayFile =
				symbols.length > 0
					? { path: file.path, size: file.size, symbols, fidelity }
					: { path: file.path, size: file.size, fidelity };

			let finalTokens =
				file.symbol_tokens || estimateTokens(JSON.stringify(displayFile));

			if (currentTokens + finalTokens > budget) {
				const pathOnly = {
					path: file.path,
					size: file.size,
					fidelity: "path",
				};
				const pathTokens = estimateTokens(JSON.stringify(pathOnly));

				if (currentTokens + pathTokens <= budget) {
					displayFile = pathOnly;
					finalTokens = pathTokens;
				} else {
					continue;
				}
			}

			displayFile.tokens = finalTokens;
			displayFile.heat = file.heat;
			finalFiles.push(displayFile);
			currentTokens += finalTokens;
		}

		// Include client-promoted files that aren't in the index (untracked)
		const clientPromos = await this.#db.get_client_promotions.all({
			project_id: this.#projectId,
		});
		const indexedPaths = new Set(rankedFiles.map((f) => f.path));
		for (const promo of clientPromos) {
			if (indexedPaths.has(promo.path)) continue;
			if (promo.constraint_type === "excluded") continue;

			const fullPath = join(this.#ctx.root, promo.path);
			let content = "";
			try {
				content = readFileSync(fullPath, "utf8");
			} catch {
				continue;
			}

			const fidelity =
				promo.constraint_type === "full:readonly" ? "full:readonly" : "full";
			const tokens = estimateTokens(content);
			finalFiles.push({
				path: promo.path,
				size: content.length,
				tokens,
				content,
				fidelity,
			});
			currentTokens += estimateTokens(
				JSON.stringify({ path: promo.path, content }),
			);
		}

		return {
			files: finalFiles,
			usage: { context_used: currentTokens, context_budget: budget },
		};
	}
}
