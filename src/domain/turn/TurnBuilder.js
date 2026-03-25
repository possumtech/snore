import { DOMImplementation } from "@xmldom/xmldom";
import PromptManager from "../prompt/PromptManager.js";
import RummyContext from "./RummyContext.js";
import Turn from "./Turn.js";

export default class TurnBuilder {
	#dom;
	#hooks;

	constructor(hooks) {
		this.#dom = new DOMImplementation();
		this.#hooks = hooks;
	}

	async build(initialData = {}) {
		const {
			type,
			project,
			model,
			db,
			prompt,
			sequence,
			hasUnknowns,
			turnId,
			runId,
			noContext,
		} = initialData;

		const doc = this.#dom.createDocument(null, "turn", null);
		const root = doc.documentElement;
		root.setAttribute("sequence", String(sequence));

		// 1. Identity / System Prompt
		const systemMd = await PromptManager.getSystemPrompt(type, null);
		const identity = PromptManager.formatIdentity(model) + systemMd;
		const systemEl = doc.createElement("system");
		systemEl.appendChild(doc.createTextNode(identity));
		root.appendChild(systemEl);

		// 2. Empty context — plugins populate this via processTurn
		const contextEl = doc.createElement("context");
		root.appendChild(contextEl);

		// 3. User Prompt wrapped in mode tag
		const userEl = doc.createElement("user");
		const modeEl = doc.createElement(type);
		const constraints = await db.get_protocol_constraints.get({
			type,
			has_unknowns: hasUnknowns ? 1 : 0,
		});
		if (constraints) {
			modeEl.setAttribute("required_tags", constraints.required_tags);
			modeEl.setAttribute("allowed_tags", constraints.allowed_tags);
		}
		modeEl.appendChild(doc.createTextNode(prompt));
		userEl.appendChild(modeEl);
		root.appendChild(userEl);

		// 4. Assistant placeholder
		const assistantEl = doc.createElement("assistant");
		root.appendChild(assistantEl);

		// 5. Run plugin pipeline (populates context with files, git changes, etc.)
		const rummy = new RummyContext(doc, {
			db,
			project,
			type,
			sequence,
			runId,
			turnId,
			noContext,
		});
		await this.#hooks.processTurn(rummy);

		// 6. COMMIT TO SQL (The Authoritative Step)
		if (db && turnId) {
			await this.saveTurnToDb(db, turnId, doc.documentElement);
		}

		// 7. Return the SQL-Hydrated Turn object
		const turn = new Turn(db, turnId);
		await turn.hydrate();
		return turn;
	}

	async saveTurnToDb(db, turnId, rootNode) {
		const traverse = async (node, parentId = null) => {
			if (node.nodeType !== 1) return;

			const attrs = {};
			if (node.attributes) {
				for (let i = 0; i < node.attributes.length; i++) {
					attrs[node.attributes[i].name] = node.attributes[i].value;
				}
			}

			let content = null;
			for (let i = 0; i < node.childNodes.length; i++) {
				if (node.childNodes[i].nodeType === 3) {
					content = (content || "") + node.childNodes[i].nodeValue;
				}
			}

			const seqValue = attrs.sequence ? parseInt(attrs.sequence, 10) : 0;

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
