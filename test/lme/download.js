/**
 * Download and cache LongMemEval dataset from HuggingFace.
 *
 * Fetches splits via the datasets server API and stores
 * them as NDJSON files in test/lme/data/. Skips splits that
 * already exist on disk.
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
const DATASET = "xiaowu0162/longmemeval-cleaned";
const BASE_URL = "https://datasets-server.huggingface.co";

const DEFAULT_SPLITS = [
	"longmemeval_s_cleaned",
	"longmemeval_oracle",
];
const ALL_SPLITS = [
	"longmemeval_s_cleaned",
	"longmemeval_m_cleaned",
	"longmemeval_oracle",
];
const PAGE_SIZE = 1;

const force = process.argv.includes("--force");
const includeAll = process.argv.includes("--all");
const splits = includeAll ? ALL_SPLITS : DEFAULT_SPLITS;

async function fetchSplitInfo(config) {
	const url = `${BASE_URL}/info?dataset=${DATASET}&config=${config}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch info for ${config}: ${res.status}`);
	const info = await res.json();
	const splitInfo = info.dataset_info?.[config]?.splits?.train;
	return splitInfo?.num_examples ?? 0;
}

async function fetchRows(config, offset, length, retries = 3) {
	const url = `${BASE_URL}/rows?dataset=${DATASET}&config=${config}&split=train&offset=${offset}&length=${length}`;

	for (let attempt = 1; attempt <= retries; attempt++) {
		const res = await fetch(url);
		if (res.ok) {
			const data = await res.json();
			return data.rows.map((r) => r.row);
		}
		if (res.status === 429 && attempt < retries) {
			const wait = attempt * 5000;
			process.stdout.write(`    rate limited, waiting ${wait / 1000}s...\r`);
			await new Promise((r) => setTimeout(r, wait));
			continue;
		}
		throw new Error(`Failed to fetch ${config} offset=${offset}: ${res.status}`);
	}
}

async function downloadSplit(config) {
	const outPath = join(DATA_DIR, `${config}.ndjson`);

	if (!force && existsSync(outPath)) {
		const stat = await fs.stat(outPath);
		if (stat.size > 0) {
			console.log(
				`  ✓ ${config} — cached (${(stat.size / 1024 / 1024).toFixed(1)} MB)`,
			);
			return;
		}
	}

	const total = await fetchSplitInfo(config);
	if (total === 0) {
		console.log(`  ✗ ${config} — no rows found`);
		return;
	}

	console.log(`  ↓ ${config} — ${total} rows`);
	const rows = [];

	for (let offset = 0; offset < total; offset += PAGE_SIZE) {
		const length = Math.min(PAGE_SIZE, total - offset);
		const batch = await fetchRows(config, offset, length);
		rows.push(...batch);
		process.stdout.write(`    ${rows.length}/${total}\r`);
	}

	const ndjson = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
	await fs.writeFile(outPath, ndjson);
	console.log(
		`  ✓ ${config} — ${rows.length} rows (${(ndjson.length / 1024 / 1024).toFixed(1)} MB)`,
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
