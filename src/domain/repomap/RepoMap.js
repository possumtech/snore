import crypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
		const reindexedFiles = [];

		for (const relPath of mappableFiles) {
			const fullPath = join(this.#ctx.root, relPath);
			if (!existsSync(fullPath)) continue;
			if (statSync(fullPath).isDirectory()) continue;

			const content = readFileSync(fullPath, "utf8");
			const size = content.length;
			const hash = crypto.createHash("sha256").update(content).digest("hex");

			const existing = fileRecords.get(relPath);

			if (existing?.hash === hash && fileTagCounts.get(relPath) > 0) {
				continue;
			}

			const { id: fileId } = await this.#db.upsert_repo_map_file.get({
				project_id: this.#projectId,
				path: relPath,
				hash,
				size,
				symbol_tokens: 0,
			});

			reindexedFiles.push({ path: relPath, fileId, content });

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
						JSON.stringify({
							path: relPath,
							symbols: symbols.map((s) =>
								s.params ? `${s.name}(${s.params.join(", ")})` : s.name,
							),
						}),
					);

					const { id: fileId } = await this.#db.upsert_repo_map_file.get({
						project_id: this.#projectId,
						path: relPath,
						hash: null,
						size: null,
						symbol_tokens: symbolWeight,
					});
					await this.#db.clear_repo_map_tags.run({ file_id: fileId });
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
				const symbolWeight = estimateTokens(
					JSON.stringify({
						path,
						symbols: symbols.map((s) =>
							s.params ? `${s.name}(${s.params})` : s.name,
						),
					}),
				);

				const { id: fileId } = await this.#db.upsert_repo_map_file.get({
					project_id: this.#projectId,
					path,
					hash: null,
					size: null,
					symbol_tokens: symbolWeight,
				});
				await this.#db.clear_repo_map_tags.run({ file_id: fileId });
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

		// Cross-reference scan removed — heat will be derived from
		// known_entries.meta (symbol data) rather than a separate table.
	}

}
