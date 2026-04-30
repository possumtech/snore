#!/usr/bin/env node

import { existsSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import resolveRummyHome from "../src/agent/rummyHome.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

const rummyHome = resolveRummyHome();

// Base dir for env files: cwd if it has .env.example, else $RUMMY_HOME.
// The package's own .env.example is never consulted — silent package-
// root defaults break the project-as-context model and hide behavior
// from the user.
const cwd = process.cwd();
const baseDir = existsSync(join(cwd, ".env.example")) ? cwd : rummyHome;

process.loadEnvFile(join(baseDir, ".env.example"));
const userEnv = join(baseDir, ".env");
if (existsSync(userEnv)) process.loadEnvFile(userEnv);

// Resolve RUMMY_HOME and make DB path absolute relative to it
process.env.RUMMY_HOME = rummyHome;
const dbPath = process.env.RUMMY_DB_PATH;
if (dbPath && !isAbsolute(dbPath)) {
	process.env.RUMMY_DB_PATH = join(rummyHome, dbPath);
}

await import(join(packageRoot, "service.js"));
