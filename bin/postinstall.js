import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import resolveRummyHome from "../src/agent/rummyHome.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const envExample = join(packageRoot, ".env.example");

const rummyHome = resolveRummyHome();

if (!existsSync(rummyHome)) {
	mkdirSync(rummyHome, { recursive: true });
}
for (const dir of ["plugins", "skills", "personas"]) {
	const path = join(rummyHome, dir);
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

copyFileSync(envExample, join(rummyHome, ".env.example"));
console.log(`[RUMMY] Configuration: ${rummyHome}/.env.example`);
console.log(`[RUMMY] Copy to ${rummyHome}/.env and add your API keys.`);
