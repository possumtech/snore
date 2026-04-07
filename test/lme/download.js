/**
 * Download and cache LongMemEval dataset from HuggingFace.
 *
 * Downloads raw JSON files from the repo and converts to NDJSON.
 * The datasets server API doesn't work for this dataset (FeaturesError),
 * so we fetch directly from the HF file resolver.
 *
 * Usage:
 *   node test/lme/download.js            # download default splits (s + oracle)
 *   node test/lme/download.js --all      # include the 2.7 GB medium split
 *   node test/lme/download.js --force    # re-download even if cached
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const REPO = "xiaowu0162/longmemeval-cleaned";
const BASE_URL = `https://huggingface.co/datasets/${REPO}/resolve/main`;

const DEFAULT_SPLITS = ["longmemeval_s_cleaned", "longmemeval_oracle"];
const ALL_SPLITS = [
	"longmemeval_s_cleaned",
	"longmemeval_m_cleaned",
	"longmemeval_oracle",
];

const force = process.argv.includes("--force");
const includeAll = process.argv.includes("--all");
const splits = includeAll ? ALL_SPLITS : DEFAULT_SPLITS;

async function downloadSplit(split) {
	const outPath = join(DATA_DIR, `${split}.ndjson`);

	if (!force && existsSync(outPath)) {
		const stat = await fs.stat(outPath);
		if (stat.size > 0) {
			console.log(
				`  ✓ ${split} — cached (${(stat.size / 1024 / 1024).toFixed(1)} MB)`,
			);
			return;
		}
	}

	const url = `${BASE_URL}/${split}.json`;
	console.log(`  ↓ ${split}`);

	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`Failed to fetch ${split}: ${res.status}`);

	const raw = await res.text();
	const rows = JSON.parse(raw);

	if (!Array.isArray(rows))
		throw new Error(`${split}: expected array, got ${typeof rows}`);

	const ndjson = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
	await fs.writeFile(outPath, ndjson);
	console.log(
		`  ✓ ${split} — ${rows.length} rows (${(ndjson.length / 1024 / 1024).toFixed(1)} MB)`,
	);
}

async function main() {
	await fs.mkdir(DATA_DIR, { recursive: true });
	console.log(`Downloading LongMemEval to ${DATA_DIR}`);
	console.log(`Splits: ${splits.join(", ")}\n`);

	for (const split of splits) {
		await downloadSplit(split);
	}

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
