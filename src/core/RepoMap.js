import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import SymbolExtractor from "./SymbolExtractor.js";

export default class RepoMap {
	#ctx;
	#hdExtractor;

	constructor(projectContext) {
		this.#ctx = projectContext;
		this.#hdExtractor = new SymbolExtractor();
	}

	/**
	 * Generates the repo map using HD (Tree-sitter) for core languages
	 * and standard (Ctags) as fallback.
	 */
	async generate() {
		const mappableFiles = await this.#ctx.getMappableFiles();
		const map = {
			files: [],
		};

		const ctagsFiles = [];

		for (const relPath of mappableFiles) {
			const ext = extname(relPath).slice(1);
			let symbols = null;

			// 1. Attempt High-Definition (Tree-sitter) extraction
			try {
				const fullPath = join(this.#ctx.root, relPath);
				const content = readFileSync(fullPath, "utf8");
				symbols = this.#hdExtractor.extract(content, ext);
			} catch {
				// Extraction or file read failed
			}

			// 2. If HD succeeded, add to map. Otherwise, queue for Ctags.
			if (symbols !== null) {
				map.files.push({ path: relPath, symbols, source: "hd" });
			} else {
				ctagsFiles.push(relPath);
			}
		}

		// 3. Fallback to Ctags for the rest
		if (ctagsFiles.length > 0) {
			const ctagsMap = this.#generateCtags(ctagsFiles);
			map.files.push(...ctagsMap);
		}

		return map;
	}

	#generateCtags(files) {
		const result = spawnSync(
			"ctags",
			[
				"--output-format=json",
				"--fields=+n",
				"-f",
				"-",
				...files,
			],
			{
				cwd: this.#ctx.root,
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
			},
		);

		if (result.status !== 0) return [];

		const tags = result.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));

		const grouped = new Map();
		for (const file of files) grouped.set(file, []);

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
		}));
	}
}
