#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Args are env-var-shape: --RUMMY_KEY=value, --RUMMY_KEY value, or
// --RUMMY_KEY (boolean shorthand → "1"). Boundary parser is strict:
// any non-conforming arg crashes with a clear error.
const ENV_FLAG = /^--([A-Z][A-Z0-9_]*)(?:=([\s\S]*))?$/;

function parseEnvArgs(argv) {
	const args = argv.slice(2);
	let i = 0;
	while (i < args.length) {
		const m = args[i].match(ENV_FLAG);
		if (!m) {
			console.error(
				`rummy-cli: unknown arg ${JSON.stringify(args[i])}. ` +
					"All args must be --KEY=value, --KEY value, or --KEY (env-var-shape).",
			);
			process.exit(2);
		}
		const [, name, inline] = m;
		if (inline !== undefined) {
			process.env[name] = inline;
			i += 1;
			continue;
		}
		const next = args[i + 1];
		if (next === undefined || next.startsWith("--")) {
			process.env[name] = "1";
			i += 1;
			continue;
		}
		process.env[name] = next;
		i += 2;
	}
}

parseEnvArgs(process.argv);

// Mirror bin/rummy.js env-loading prelude. Same cascade:
// cwd/.env.example wins if present (npm scripts already loaded it via
// --env-file-if-exists; this is the standalone fallback); else
// RUMMY_HOME/.env.example → RUMMY_HOME/.env. CLI flags set above
// trump every env file (Node's loadEnvFile preserves existing vars).
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "../../..");
const rummyHome = process.env.RUMMY_HOME || join(homedir(), ".rummy");

const cwd = process.cwd();
const baseDir = existsSync(join(cwd, ".env.example")) ? cwd : rummyHome;
if (existsSync(join(baseDir, ".env.example"))) {
	process.loadEnvFile(join(baseDir, ".env.example"));
}
const userEnv = join(baseDir, ".env");
if (existsSync(userEnv)) process.loadEnvFile(userEnv);

process.env.RUMMY_HOME = rummyHome;
const dbPath = process.env.RUMMY_DB_PATH;
if (dbPath && !isAbsolute(dbPath)) {
	process.env.RUMMY_DB_PATH = join(rummyHome, dbPath);
}

await import(join(packageRoot, "service.js"));
