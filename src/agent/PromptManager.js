import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");

export default class PromptManager {
	static async getSystemPrompt(type, customPrompt = null) {
		if (customPrompt) return customPrompt;

		const modePath = join(ROOT_DIR, `system.${type}.md`);
		try {
			return await fs.readFile(modePath, "utf8");
		} catch (_err) {
			try {
				return await fs.readFile(join(ROOT_DIR, "system.md"), "utf8");
			} catch (__err) {
				return "You are a helpful software engineering assistant.";
			}
		}
	}

	static formatIdentity(_model) {
		return "";
	}
}
