import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");

const promptCache = new Map();

export default class PromptManager {
	static async getSystemPrompt(
		_mode,
		{ db = null, sessionId = null, hooks = null } = {},
	) {
		// Base system prompt from file (cached — single prompt.md for all modes)
		let base = promptCache.get("system");
		if (!base) {
			try {
				base = await fs.readFile(join(ROOT_DIR, "prompt.md"), "utf8");
			} catch {
				base = "You are a helpful software engineering assistant.";
			}
			promptCache.set("system", base);
		}

		let prompt = base;

		// Replace [%TOOLS%] with registered tool names
		if (hooks?.tools) {
			const toolNames = [...hooks.tools.names]
				.map((t) => `\`<${t}/>\``)
				.join(" ");
			prompt = prompt.replace("[%TOOLS%]", toolNames);
		}

		// Persona injection from session
		if (db && sessionId) {
			const session = await db.get_session_by_id.get({ id: sessionId });
			if (session?.persona) {
				return `${prompt}\n\n## Persona\n\n${session.persona}`;
			}
		}

		return prompt;
	}
}
