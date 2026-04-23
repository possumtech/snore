#!/usr/bin/env node
// Validate 1:1 coverage between snake_case anchors and integration
// + e2e test references across every anchored doc. Exits 1 on any
// missing link in either direction.
//
// Rule (SPEC.md → spec_anchored_testing): every heading with an
// explicit `{#snake_case_id}` anchor — in SPEC.md, PLUGINS.md, or
// any src/plugins/*/README.md — has at least one `@snake_case_id`
// reference in test/integration/ or test/e2e/. Every test file in
// those dirs references at least one `@`-anchor. Anchors die on
// rename; they're permanent once published.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DOC_FILES = [join(ROOT, "SPEC.md"), join(ROOT, "PLUGINS.md")];
const PLUGIN_DOCS_DIR = join(ROOT, "src/plugins");
const TEST_DIRS = [join(ROOT, "test/integration"), join(ROOT, "test/e2e")];

// Heading with explicit snake_case anchor: "## Title {#snake_case_id}"
const HEADING_RE = /^#+\s+(.+?)\s*\{#([a-z0-9_]+)\}\s*$/gm;
// Test reference: "@snake_case_id" as a standalone token. The
// lookbehind ensures we don't match addresses, npm packages, etc.
const REF_RE = /(?<![a-zA-Z0-9_/@])@([a-z][a-z0-9_]*)\b/g;

async function readAnchorsFromFile(file) {
	const text = await readFile(file, "utf8");
	const rel = file.replace(ROOT, "");
	const anchors = [];
	for (const m of text.matchAll(HEADING_RE)) {
		anchors.push({ id: m[2], title: m[1].trim(), source: rel });
	}
	return anchors;
}

async function readAllAnchors() {
	const sources = [...DOC_FILES];
	const pluginDirs = await readdir(PLUGIN_DOCS_DIR, {
		withFileTypes: true,
	}).catch(() => []);
	for (const d of pluginDirs) {
		if (!d.isDirectory()) continue;
		sources.push(join(PLUGIN_DOCS_DIR, d.name, "README.md"));
	}
	const anchors = [];
	const seen = new Map();
	for (const src of sources) {
		const fromThisFile = await readAnchorsFromFile(src).catch(() => []);
		for (const a of fromThisFile) {
			const prior = seen.get(a.id);
			if (prior) {
				throw new Error(
					`Duplicate anchor @${a.id}: defined in ${prior} and ${a.source}. Anchors must be unique across all docs.`,
				);
			}
			seen.set(a.id, a.source);
			anchors.push(a);
		}
	}
	return anchors;
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

async function main() {
	const anchors = await readAllAnchors();
	const { fileRefs, allRefs } = await gatherRefs();

	const errors = [];

	// Direction 1: every anchor has >=1 test reference.
	for (const a of anchors) {
		if (!allRefs.has(a.id)) {
			errors.push(
				`MISSING TEST: @${a.id} "${a.title}" [${a.source}] has no reference in test/integration or test/e2e`,
			);
		}
	}

	// Direction 2: every test file references >=1 anchor, and every
	// reference points at a real anchor.
	const anchorIds = new Set(anchors.map((a) => a.id));
	for (const [file, refs] of fileRefs) {
		if (refs.size === 0) {
			errors.push(
				`UNANCHORED TEST: ${file.replace(ROOT, "")} references no @-anchor`,
			);
			continue;
		}
		for (const r of refs) {
			if (!anchorIds.has(r)) {
				errors.push(
					`DEAD REFERENCE: ${file.replace(ROOT, "")} references @${r} which is not a known anchor`,
				);
			}
		}
	}

	if (errors.length > 0) {
		console.error("SPEC coverage check FAILED:\n");
		for (const e of errors) console.error(`  ${e}`);
		console.error(
			`\n${errors.length} violation(s). See SPEC.md section spec_anchored_testing.`,
		);
		process.exit(1);
	}

	console.log(
		`SPEC coverage OK: ${anchors.length} anchors × ${fileRefs.size} test files.`,
	);
}

await main();
