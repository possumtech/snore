/**
 * Download and cache MemoryAgentBench dataset from HuggingFace.
 *
 * Fetches all 4 splits via the datasets server API and stores
 * them as NDJSON files in test/mab/data/. Skips splits that
 * already exist on disk.
 *
 * Usage:
 *   node test/mab/download.js            # download all splits
 *   node test/mab/download.js --force     # re-download even if cached
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DATASET = "ai-hyz/MemoryAgentBench";
const BASE_URL = "https://datasets-server.huggingface.co";
const SPLITS = [
	"Accurate_Retrieval",
	"Test_Time_Learning",
	"Long_Range_Understanding",
	"Conflict_Resolution",
];
const PAGE_SIZE = 5;

const force = process.argv.includes("--force");

async function fetchSplitInfo(split) {
	const url = `${BASE_URL}/info?dataset=${DATASET}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch info: ${res.status}`);
	const info = await res.json();
	const splitInfo = info.dataset_info?.default?.splits?.[split];
	return splitInfo?.num_examples ?? 0;
}

async function fetchRows(split, offset, length, retries = 3) {
	const url = `${BASE_URL}/rows?dataset=${DATASET}&config=default&split=${split}&offset=${offset}&length=${length}`;

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
		throw new Error(`Failed to fetch ${split} offset=${offset}: ${res.status}`);
	}
}

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

	const total = await fetchSplitInfo(split);
	if (total === 0) {
		console.log(`  ✗ ${split} — no rows found`);
		return;
	}

	console.log(`  ↓ ${split} — ${total} rows`);
	const rows = [];

	for (let offset = 0; offset < total; offset += PAGE_SIZE) {
		const length = Math.min(PAGE_SIZE, total - offset);
		const batch = await fetchRows(split, offset, length);
		rows.push(...batch);
		process.stdout.write(`    ${rows.length}/${total}\r`);
	}

	const ndjson = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
	await fs.writeFile(outPath, ndjson);
	console.log(
		`  ✓ ${split} — ${rows.length} rows (${(ndjson.length / 1024 / 1024).toFixed(1)} MB)`,
	);
}

async function main() {
	await fs.mkdir(DATA_DIR, { recursive: true });
	console.log(`Downloading MemoryAgentBench to ${DATA_DIR}`);
	console.log(`Splits: ${SPLITS.join(", ")}\n`);

	for (const split of SPLITS) {
		await downloadSplit(split);
	}

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
