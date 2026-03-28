import PromptManager from "../prompt/PromptManager.js";
import RummyContext from "./RummyContext.js";
import Turn from "./Turn.js";

export default class TurnBuilder {
	#hooks;

	constructor(hooks) {
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
			contextSize,
		} = initialData;

		const root = {
			tag: "turn",
			attrs: { sequence: String(sequence) },
			content: null,
			children: [],
		};

		const systemMd = await PromptManager.getSystemPrompt(type, null);
		const identity = PromptManager.formatIdentity(model) + systemMd;
		root.children.push({ tag: "system", attrs: {}, content: identity, children: [] });
		root.children.push({ tag: "context", attrs: {}, content: null, children: [] });
		root.children.push({ tag: "user", attrs: {}, content: prompt, children: [] });
		root.children.push({ tag: "assistant", attrs: {}, content: null, children: [] });

		const rummy = new RummyContext(root, {
			db,
			project,
			type,
			sequence,
			runId,
			turnId,
			noContext,
			contextSize,
		});
		await this.#hooks.processTurn(rummy);

		if (db && turnId) {
			await TurnBuilder.saveTurnToDb(db, turnId, root);
		}

		const turn = new Turn(db, turnId);
		await turn.hydrate();
		return turn;
	}

	static async saveTurnToDb(db, turnId, node, parentId = null) {
		const attrs = node.attrs || {};
		const seqValue = attrs.sequence ? parseInt(attrs.sequence, 10) : 0;

		const { id } = await db.insert_turn_element.get({
			turn_id: turnId,
			parent_id: parentId,
			tag_name: node.tag,
			attributes: JSON.stringify(attrs),
			content: node.content,
			sequence: seqValue,
		});

		for (const child of node.children) {
			await TurnBuilder.saveTurnToDb(db, turnId, child, id);
		}
	}
}
