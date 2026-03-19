import { DOMImplementation } from "@xmldom/xmldom";
import PromptManager from "../prompt/PromptManager.js";
import RummyContext from "./RummyContext.js";
import Turn from "./Turn.js";

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
		const { prompt, sessionId, db, project, type, model, ...contextData } =
			initialData;

		// 1. Create fresh Document
		const doc = this.#dom.createDocument(null, "turn", null);
		const root = doc.documentElement;
		if (initialData.sequence !== undefined) {
			root.setAttribute("sequence", initialData.sequence);
		}

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
		const rummy = new RummyContext(doc, {
			sessionId,
			db,
			project,
			type,
			model,
			...contextData,
		});

		let customPrompt = null;

		// Fetch Session Data if db is available
		if (db && sessionId) {
			const sessions = await db.get_session_by_id.all({ id: sessionId });
			if (sessions.length > 0) {
				const session = sessions[0];
				customPrompt = session.system_prompt;

				if (session.persona) {
					contextEl.appendChild(rummy.tag("persona", {}, [session.persona]));
				}

				const skills = await db.get_session_skills.all({
					session_id: sessionId,
				});
				for (const skill of skills) {
					const skillsEl =
						contextEl.getElementsByTagName("skills")[0] ||
						doc.createElement("skills");
					if (!skillsEl.parentNode) contextEl.appendChild(skillsEl);
					skillsEl.appendChild(rummy.tag("skill", {}, [skill.name]));
				}
			}
		}

		// Assembly System Prompt
		const basePrompt = await PromptManager.getSystemPrompt(
			type,
			customPrompt || null,
		);

		system.appendChild(doc.createTextNode(`${basePrompt.trim()}\n`));

		// 4. Seed the User Prompt with state-aware guardrails
		const actionTag = type === "act" ? "act" : "ask";

		// Determine allowed tags based on previous turn's state
		const hasUnknowns = contextData.hasUnknowns ?? true; // Default to true for Turn 0
		const _tasksComplete = contextData.tasksComplete ?? false;

		const required = "tasks known unknown";
		let allowed = `${required} read env`;

		if (!hasUnknowns) {
			allowed += " edit create delete run analysis summary";
		}

		const userEl = rummy.tag(
			actionTag,
			{
				required_tags: required,
				allowed_tags: allowed,
			},
			[prompt],
		);

		user.appendChild(userEl);

		// 5. Run the Pipeline
		await this.#hooks.processTurn(rummy);

		return new Turn(doc);
	}
}
