/**
 * Download SWE-bench Verified Mini dataset from HuggingFace.
 *
 * Fetches all 50 rows via the datasets-server API and stores them
 * as NDJSON in test/swe/data/.
 *
 * Usage:
 *   node test/swe/download.js          # download (skip if cached)
 *   node test/swe/download.js --force  # re-download
 */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DATASET = "MariusHobbhahn/swe-bench-verified-mini";
const BASE_URL = "https://datasets-server.huggingface.co";
const SPLIT = "test";
const PAGE_SIZE = 25;

const force = process.argv.includes("--force");

async function fetchInfo() {
	const url = `${BASE_URL}/info?dataset=${DATASET}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch info: ${res.status}`);
	const info = await res.json();
	return info.dataset_info?.default?.splits?.[SPLIT]?.num_examples ?? 0;
}

async function fetchRows(offset, length, retries = 3) {
	const url = `${BASE_URL}/rows?dataset=${DATASET}&config=default&split=${SPLIT}&offset=${offset}&length=${length}`;
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
		throw new Error(`Failed to fetch offset=${offset}: ${res.status}`);
	}
}

async function main() {
	await fs.mkdir(DATA_DIR, { recursive: true });
	const outPath = join(DATA_DIR, `${SPLIT}.ndjson`);

	if (!force && existsSync(outPath)) {
		const stat = await fs.stat(outPath);
		if (stat.size > 0) {
			console.log(
				`  ✓ cached (${(stat.size / 1024 / 1024).toFixed(1)} MB at ${outPath})`,
			);
			return;
		}
	}

	const total = await fetchInfo();
	console.log(`Downloading ${DATASET} (${SPLIT}) — ${total} rows`);

	const rows = [];
	for (let offset = 0; offset < total; offset += PAGE_SIZE) {
		const length = Math.min(PAGE_SIZE, total - offset);
		const batch = await fetchRows(offset, length);
		rows.push(...batch);
		process.stdout.write(`    ${rows.length}/${total}\r`);
	}

	const ndjson = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
	await fs.writeFile(outPath, ndjson);
	console.log(
		`  ✓ ${rows.length} rows (${(ndjson.length / 1024 / 1024).toFixed(1)} MB at ${outPath})`,
	);
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
