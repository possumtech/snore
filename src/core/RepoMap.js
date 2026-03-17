import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
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

			const ext = extname(relPath).slice(1);
			const extraction = this.#hdExtractor.extract(content, ext);

			if (extraction) {
				const { id: fileId } = await this.#db.upsert_repo_map_file.get({
					project_id: this.#projectId,
					path: relPath,
					hash,
					size,
					visibility,
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

		for (const relPath of activeFiles) {
			const refs = await this.#db.get_file_references.all({
				project_id: this.#projectId,
				path: relPath,
			});
			for (const r of refs) globalReferences.add(r.symbol_name);
		}

		const allTags = await this.#db.get_project_repo_map.all({
			project_id: this.#projectId,
		});
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

		const sortedFiles = Array.from(filesMap.values())
			.map((entry) => {
				const isActive = activeFiles.includes(entry.path);
				const isReferenced = entry.symbols.some((s) =>
					globalReferences.has(s.name),
				);
				const isHot = isActive || isReferenced;
				const rank = isActive ? 2 : isReferenced ? 1 : 0;

				const symbols = entry.symbols.map((s) => {
					if (isHot) return s;
					const { params, line, ...cold } = s;
					return cold;
				});

				return { ...entry, mode: isHot ? "hot" : "cold", symbols, rank };
			})
			.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));

		const pruned = [];
		let currentTokens = 0;

		for (const file of sortedFiles) {
			const estTokens = this.#tokenizer.encode(JSON.stringify(file)).length;
			if (currentTokens + estTokens > budget && file.rank === 0) continue;
			pruned.push(file);
			currentTokens += estTokens;
		}

		return {
			files: pruned,
			usage: { tokens: currentTokens, budget },
		};
	}

	#generateCtags(paths) {
		const result = spawnSync(
			"ctags",
			["--output-format=json", "--fields=+n", "-f", "-", ...paths],
			{ cwd: this.#ctx.root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
		);

		if (result.status !== 0) throw new Error(`Ctags failed: ${result.stderr}`);

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
