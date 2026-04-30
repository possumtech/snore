import { homedir } from "node:os";
import { join } from "node:path";

// RUMMY_HOME default per README §Installation; resolved here because
// entrypoints run before env files load.
export default function resolveRummyHome() {
	if (process.env.RUMMY_HOME) return process.env.RUMMY_HOME;
	return join(homedir(), ".rummy");
}
