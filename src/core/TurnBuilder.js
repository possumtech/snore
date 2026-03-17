import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMImplementation } from "@xmldom/xmldom";
import RummyContext from "./RummyContext.js";
import Turn from "./Turn.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYSTEM_MD_PATH = join(__dirname, "../../../system.md");

export default class TurnBuilder {
	#hooks;
	#dom = new DOMImplementation();

	constructor(hooks) {
		this.#hooks = hooks;
	}

	/**
	 * Build a structured Turn by running the DOM pipeline.
	 */
	async build(initialData = {}) {
		const { prompt, sessionId, db, project, ...contextData } = initialData;

		// 1. Create fresh Document
		const doc = this.#dom.createDocument(null, "turn", null);
		const root = doc.documentElement;

		// 2. Scaffold Basic Structure
		const system = doc.createElement("system");
		const contextEl = doc.createElement("context");
		const user = doc.createElement("user");
		const assistant = doc.createElement("assistant");

		root.appendChild(system);
		root.appendChild(contextEl);
		root.appendChild(user);
		root.appendChild(assistant);

		// 3. Create RummyContext for the Pipeline
		const rummy = new RummyContext(doc, { sessionId, db, project, ...contextData });

		let systemPromptText = null;

		// Fetch and Inject System Prompt, Persona, and Skills if db is available
		if (db && sessionId) {
			const sessions = await db.get_session_by_id.all({ id: sessionId });
			if (sessions.length > 0) {
				const session = sessions[0];
				
				if (session.system_prompt) {
					systemPromptText = session.system_prompt;
				}

				if (session.persona) {
					const personaEl = rummy.tag("persona", {}, [session.persona]);
					contextEl.appendChild(personaEl);
				}

				const skills = await db.get_session_skills.all({ session_id: sessionId });
				if (skills.length > 0) {
					const skillsEl = doc.createElement("skills");
					for (const skill of skills) {
						skillsEl.appendChild(rummy.tag("skill", {}, [skill.name]));
					}
					contextEl.appendChild(skillsEl);
				}
			}
		}

		if (!systemPromptText) {
			try {
				systemPromptText = await fs.readFile(DEFAULT_SYSTEM_MD_PATH, "utf8");
			} catch (err) {
				// Fallback if system.md is missing
				systemPromptText = "You are a helpful software engineering assistant.";
			}
		}

		if (systemPromptText) {
			system.appendChild(doc.createTextNode(systemPromptText.trim() + "\n"));
		}

		// 4. Seed the User Prompt
		const actionTag = initialData.type === "act" ? "act" : "ask";
		const actionEl = rummy.tag(actionTag, {}, [prompt]);
		user.appendChild(actionEl);

		// 5. Run the Pipeline
		await this.#hooks.processTurn(rummy);

		return new Turn(doc);
	}
}
