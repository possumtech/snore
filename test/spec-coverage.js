#!/usr/bin/env node
// Validate 1:1 coverage between SPEC.md numbered sections and
// integration + e2e test references. Exits 1 on any missing link
// in either direction.
//
// Rule (SPEC §10.1): every `## X.` and `### X.Y` heading in SPEC.md
// has at least one `§X[.Y[.Z]]` reference in test/integration/ or
// test/e2e/. Every test under those dirs references at least one §.

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SPEC = join(ROOT, "SPEC.md");
const TEST_DIRS = [join(ROOT, "test/integration"), join(ROOT, "test/e2e")];

const HEADING_RE = /^(#+)\s+([0-9]+(?:\.[0-9]+)*)\.?\s+(.+)$/gm;
const REF_RE = /§([0-9]+(?:\.[0-9]+)*)/g;

async function readSpecSections() {
	const text = await readFile(SPEC, "utf8");
	const sections = [];
	for (const m of text.matchAll(HEADING_RE)) {
		sections.push({ id: m[2], title: m[3].trim() });
	}
	return sections;
}

async function walkJs(dir) {
	const out = [];
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			out.push(...(await walkJs(full)));
		} else if (e.isFile() && e.name.endsWith(".test.js")) {
			out.push(full);
		}
	}
	return out;
}

async function gatherRefs() {
	const fileRefs = new Map();
	const allRefs = new Set();
	for (const dir of TEST_DIRS) {
		const files = await walkJs(dir);
		for (const file of files) {
			const text = await readFile(file, "utf8");
			const refs = new Set();
			for (const m of text.matchAll(REF_RE)) {
				refs.add(m[1]);
				allRefs.add(m[1]);
			}
			fileRefs.set(file, refs);
		}
	}
	return { fileRefs, allRefs };
}

function referenceMatches(sectionId, ref) {
	// A reference to a parent also counts as a reference to its
	// children. E.g. §4 in a test anchors to §4, §4.1, §4.2, ...
	// But we want a test on §4.2 to count for §4.2 specifically; a
	// test tagged only with §4 does NOT count as covering §4.2.
	return ref === sectionId;
}

async function main() {
	const sections = await readSpecSections();
	const { fileRefs, allRefs } = await gatherRefs();

	const errors = [];

	// Direction 1: every SPEC section must have >=1 test reference.
	for (const s of sections) {
		if (![...allRefs].some((r) => referenceMatches(s.id, r))) {
			errors.push(`MISSING TEST: §${s.id} "${s.title}" has no reference in test/integration or test/e2e`);
		}
	}

	// Direction 2: every test file must reference >=1 SPEC section.
	const specIds = new Set(sections.map((s) => s.id));
	for (const [file, refs] of fileRefs) {
		if (refs.size === 0) {
			errors.push(`UNANCHORED TEST: ${file.replace(ROOT, "")} references no §-section`);
			continue;
		}
		for (const r of refs) {
			if (!specIds.has(r)) {
				errors.push(`DEAD REFERENCE: ${file.replace(ROOT, "")} references §${r} which is not a SPEC.md heading`);
			}
		}
	}

	if (errors.length > 0) {
		console.error("SPEC coverage check FAILED:\n");
		for (const e of errors) console.error(`  ${e}`);
		console.error(`\n${errors.length} violation(s). See SPEC §10.1.`);
		process.exit(1);
	}

	console.log(
		`SPEC coverage OK: ${sections.length} sections × ${fileRefs.size} test files.`,
	);
}

await main();
