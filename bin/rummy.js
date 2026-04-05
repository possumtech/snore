#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

const rummyHome = process.env.RUMMY_HOME || join(homedir(), ".rummy");
process.env.RUMMY_HOME = rummyHome;

process.loadEnvFile(join(packageRoot, ".env.example"));
const userEnv = join(rummyHome, ".env");
if (existsSync(userEnv)) process.loadEnvFile(userEnv);

await import(join(packageRoot, "service.js"));
