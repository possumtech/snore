import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { open as openZip } from "yauzl-promise";
import docs from "./skillDoc.js";

export default class Skill {
	#core;

	constructor(core) {
		this.#core = core;
		core.registerScheme({ name: "skill", category: "data" });
		core.hooks.tools.onView("skill", (entry) => entry.body, "visible");
		core.hooks.tools.onView("skill", () => "", "summarized");

		core.on("handler", this.handler.bind(this));
		core.filter("instructions.toolDocs", async (docsMap) => {
			docsMap.skill = docs;
			return docsMap;
		});
	}

	async handler(entry, rummy) {
		const {
			entries: store,
			sequence: turn,
			runId,
			loopId,
			db,
			projectId,
		} = rummy;
		const path = entry.attributes.path;
		if (!path) {
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: 'Missing required "path" on <skill>.',
				state: "failed",
				outcome: "validation",
			});
			return;
		}

		const projectRoot = await projectRootFor(db, projectId);
		let resolved;
		try {
			resolved = await resolveSource(path, projectRoot);
		} catch (err) {
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: err.message,
				state: "failed",
				outcome: "not_found",
				attributes: { path },
			});
			return;
		}

		const { name, files, cleanup } = resolved;
		try {
			let added = 0;
			for (const { relPath, body } of files) {
				const isRoot = relPath === "";
				const skillPath = isRoot
					? `skill://${name}`
					: `skill://${name}/${relPath}`;
				await store.set({
					runId,
					turn,
					path: skillPath,
					body,
					state: "resolved",
					visibility: isRoot ? "summarized" : "archived",
					attributes: { source: path },
					loopId,
				});
				added += 1;
			}
			await store.set({
				runId,
				turn,
				loopId,
				path: entry.resultPath,
				body: `skill '${name}' added: ${added} entr${added === 1 ? "y" : "ies"} at skill://${name}${added > 1 ? "/*" : ""}`,
				state: "resolved",
				attributes: { path, name, count: added },
			});
		} finally {
			if (cleanup) await cleanup();
		}
	}
}

async function projectRootFor(db, projectId) {
	if (!projectId) return null;
	const project = await db.get_project_by_id.get({ id: projectId });
	return project.project_root;
}

function isUrl(p) {
	return /^https?:\/\//.test(p);
}

async function resolveSource(rawPath, projectRoot) {
	if (isUrl(rawPath)) return resolveUrl(rawPath);
	const absPath = isAbsolute(rawPath)
		? rawPath
		: projectRoot
			? join(projectRoot, rawPath)
			: rawPath;
	const st = await stat(absPath).catch(() => null);
	if (!st) throw new Error(`skill source not found: ${rawPath}`);

	if (st.isDirectory()) {
		const name = basename(absPath);
		const files = await walkFolder(absPath);
		return { name, files, cleanup: null };
	}
	if (extname(absPath).toLowerCase() === ".zip") {
		const name = basename(absPath, extname(absPath));
		const files = await extractZipToFiles(absPath);
		return { name, files, cleanup: null };
	}
	const name = basename(absPath, extname(absPath));
	const body = await readFile(absPath, "utf8");
	return { name, files: [{ relPath: "", body }], cleanup: null };
}

async function resolveUrl(url) {
	const u = new URL(url);
	const pathBase = basename(u.pathname);
	const ext = extname(pathBase).toLowerCase();
	const res = await fetch(url);
	if (!res.ok) throw new Error(`skill fetch failed (${res.status}): ${url}`);
	const ctype = res.headers.get("content-type");
	const isZip = ext === ".zip" || ctype?.includes("application/zip");
	if (isZip) {
		const buf = Buffer.from(await res.arrayBuffer());
		const tmp = await mkdtemp(join(tmpdir(), "rummy-skill-"));
		const zipPath = join(tmp, "src.zip");
		await writeFile(zipPath, buf);
		const files = await extractZipToFiles(zipPath);
		const name = basename(pathBase, ext);
		return {
			name,
			files,
			cleanup: () => rm(tmp, { recursive: true, force: true }),
		};
	}
	const body = await res.text();
	const name = basename(pathBase, ext);
	return { name, files: [{ relPath: "", body }], cleanup: null };
}

async function walkFolder(root) {
	const out = [];
	for await (const file of walk(root)) {
		if (extname(file).toLowerCase() !== ".md") continue;
		const body = await readFile(file, "utf8");
		out.push({ relPath: relPathFor(root, file), body });
	}
	return out;
}

async function* walk(dir) {
	const dirents = await readdir(dir, { withFileTypes: true });
	for (const e of dirents) {
		const full = join(dir, e.name);
		if (e.isDirectory()) yield* walk(full);
		else yield full;
	}
}

async function extractZipToFiles(zipPath) {
	const zip = await openZip(zipPath);
	const out = [];
	try {
		for await (const entry of zip) {
			if (entry.filename.endsWith("/")) continue;
			if (extname(entry.filename).toLowerCase() !== ".md") continue;
			const stream = await entry.openReadStream();
			const chunks = [];
			for await (const chunk of stream) chunks.push(chunk);
			const body = Buffer.concat(chunks).toString("utf8");
			const stripped = stripTopFolder(entry.filename);
			out.push({ relPath: relPathFromArchive(stripped), body });
		}
	} finally {
		await zip.close();
	}
	return out;
}

function stripTopFolder(p) {
	const idx = p.indexOf("/");
	if (idx === -1) return p;
	return p.slice(idx + 1);
}

function relPathFor(root, full) {
	const rel = relative(root, full).replaceAll("\\", "/");
	return mapToSkillRel(rel);
}

function relPathFromArchive(rel) {
	return mapToSkillRel(rel);
}

// "index.md"        → ""           (root)
// "foo.md"          → "foo"
// "foo/index.md"    → "foo"
// "foo/bar.md"      → "foo/bar"
function mapToSkillRel(rel) {
	const noExt = rel.replace(/\.md$/i, "");
	if (noExt === "index") return "";
	return noExt.replace(/\/index$/, "");
}
