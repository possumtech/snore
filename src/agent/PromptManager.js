import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");

export default class PromptManager {
	static async getSystemPrompt(type, { db = null, sessionId = null } = {}) {
		// Base system prompt from file
		const modePath = join(ROOT_DIR, `system.${type}.md`);
		let base;
		try {
			base = await fs.readFile(modePath, "utf8");
		} catch {
			try {
				base = await fs.readFile(join(ROOT_DIR, "system.md"), "utf8");
			} catch {
				base = "You are a helpful software engineering assistant.";
			}
		}

		// Persona injection from session
		if (db && sessionId) {
			const session = await db.get_session_by_id.get({ id: sessionId });
			if (session?.persona) {
				base += `\n\n## Persona\n\n${session.persona}`;
			}
		}

		return base;
	}
}
