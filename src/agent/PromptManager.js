import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");

const promptCache = new Map();

export default class PromptManager {
	static async getSystemPrompt(
		type,
		{ db = null, sessionId = null, hooks = null } = {},
	) {
		// Base system prompt from file (cached after first read)
		let base = promptCache.get(type);
		if (!base) {
			const modePath = join(ROOT_DIR, `prompt.${type}.md`);
			try {
				base = await fs.readFile(modePath, "utf8");
			} catch {
				try {
					base = await fs.readFile(join(ROOT_DIR, "system.md"), "utf8");
				} catch {
					base = "You are a helpful software engineering assistant.";
				}
			}
			promptCache.set(type, base);
		}

		// Plugin tool documentation injection
		let prompt = base;
		if (hooks?.prompt?.tools) {
			const pluginTools = await hooks.prompt.tools.filter([], { type });
			if (pluginTools.length > 0) {
				prompt = `${prompt}\n\n${pluginTools.join("\n\n")}`;
			}
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
