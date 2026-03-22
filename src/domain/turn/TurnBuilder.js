import { DOMImplementation } from "@xmldom/xmldom";
import PromptManager from "../prompt/PromptManager.js";
import RummyContext from "./RummyContext.js";
import Turn from "./Turn.js";

/**
 * TurnBuilder: Orchestrates the construction of a Turn XML Document.
 * It runs the pipeline, then COMMITS the resulting structure to SQL.
 */
export default class TurnBuilder {
	#hooks;
	#dom = new DOMImplementation();

	constructor(hooks) {
		this.#hooks = hooks;
	}

	async build(initialData = {}) {
		const {
			prompt,
			sessionId,
			db,
			project,
			type,
			model,
			turnId,
			sequence = 0,
			feedback = null,
		} = initialData;

		// 1. Create fresh Pipeline Document
		const doc = this.#dom.createDocument(null, "turn", null);
		const root = doc.documentElement;
		root.setAttribute("sequence", String(sequence));

		// 2. Scaffold Basic Structure
		const systemEl = doc.createElement("system");
		const contextEl = doc.createElement("context");
		const userEl = doc.createElement("user");
		const assistantEl = doc.createElement("assistant");

		root.appendChild(systemEl);
		root.appendChild(contextEl);
		root.appendChild(userEl);
		root.appendChild(assistantEl);

		// 3. Create Context for Pipeline
		const rummy = new RummyContext(doc, {
			sessionId,
			db,
			project,
			type,
			model,
			turnId,
			...initialData,
		});

		// 3.1 Inject Feedback from database/transient logic
		if (feedback) {
			const { errors = [], infos = [] } = feedback;
			for (const err of errors) {
				const el = doc.createElement("error");
				if (err.attrs) {
					for (const [k, v] of Object.entries(err.attrs)) el.setAttribute(k, v);
				}
				el.appendChild(doc.createTextNode(err.content));
				contextEl.appendChild(el);
			}
			for (const info of infos) {
				const el = doc.createElement("info");
				if (info.attrs) {
					for (const [k, v] of Object.entries(info.attrs))
						el.setAttribute(k, v);
				}
				el.appendChild(doc.createTextNode(info.content));
				contextEl.appendChild(el);
			}
		}

		// 3.2 Fetch Session Metadata
		let customPrompt = null;
		if (db && sessionId) {
			const sessions = await db.get_session_by_id.all({ id: sessionId });
			if (sessions[0]) {
				customPrompt = sessions[0].system_prompt;
				if (sessions[0].persona) {
					contextEl.appendChild(
						rummy.tag("persona", {}, [sessions[0].persona]),
					);
				}
				const skills = await db.get_session_skills.all({
					session_id: sessionId,
				});
				if (skills.length > 0) {
					const skillsEl = doc.createElement("skills");
					for (const s of skills)
						skillsEl.appendChild(rummy.tag("skill", {}, [s.name]));
					contextEl.appendChild(skillsEl);
				}
			}
		}

		// 4. Assemble System Instructions
		const baseSystem = await PromptManager.getSystemPrompt(type, customPrompt);
		systemEl.appendChild(doc.createTextNode(baseSystem.trim()));

		// 5. Build State-Aware User Tag
		const actionTag = type === "act" ? "act" : "ask";
		let required = "tasks known unknown";
		let allowed = "tasks known unknown read drop env prompt_user summary";

		if (db) {
			const constraints = await db.get_protocol_constraints.get({
				type,
				has_unknowns: initialData.hasUnknowns ? 1 : 0,
			});
			if (constraints) {
				required = constraints.required_tags;
				allowed = constraints.allowed_tags;
			}
		}

		const wrapper = rummy.tag(
			actionTag,
			{ required_tags: required, allowed_tags: allowed },
			[prompt],
		);
		userEl.appendChild(wrapper);

		// 6. Run the Domain Pipeline (Plugins add files, repo-maps, etc.)
		await this.#hooks.processTurn(rummy);

		// 7. COMMIT TO SQL (The Authoritative Step)
		if (db && turnId) {
			await this.saveTurnToDb(db, turnId, doc.documentElement);
		}

		// 8. Return the SQL-Hydrated Turn object
		const turn = new Turn(db, turnId);
		await turn.hydrate();
		return turn;
	}

	/**
	 * Recursively saves the DOM structure to the turn_elements table.
	 */
	async saveTurnToDb(db, turnId, rootNode) {
		// 1. Persist entire XML to turn payload for safety
		const serializer = new (await import("@xmldom/xmldom")).XMLSerializer();
		await db.update_turn_payload.run({
			id: turnId,
			payload: serializer.serializeToString(rootNode.ownerDocument),
		});

		const traverse = async (node, parentId = null) => {
			if (node.nodeType !== 1) return;

			const attrs = {};
			if (node.attributes) {
				for (let i = 0; i < node.attributes.length; i++) {
					attrs[node.attributes[i].name] = node.attributes[i].value;
				}
			}

			// Calculate sibling sequence
			let seqValue = 0;
			let prev = node.previousSibling;
			while (prev) {
				if (prev.nodeType === 1) seqValue++;
				prev = prev.previousSibling;
			}

			// Identify simple text content
			let content = null;
			if (
				node.childNodes.length === 1 &&
				node.firstChild.nodeType === 3 // Text node
			) {
				content = node.firstChild.nodeValue;
			}

			const { id } = await db.insert_turn_element.get({
				turn_id: turnId,
				parent_id: parentId,
				tag_name: node.tagName,
				attributes: JSON.stringify(attrs),
				content,
				sequence: seqValue,
			});

			for (let i = 0; i < node.childNodes.length; i++) {
				await traverse(node.childNodes[i], id);
			}
		};

		await traverse(rootNode);
	}
}
