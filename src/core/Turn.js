import Slot from "./Slot.js";

/**
 * The Turn class represents the structured data of a single LLM round.
 */
export default class Turn {
	system = {
		before: new Slot(),
		content: new Slot(),
		after: new Slot(),
		systemAfter: new Slot(),
	};

	context = {
		before: new Slot(),
		filesBefore: new Slot(),
		files: new Slot(),
		filesAfter: new Slot(),
		gitBefore: new Slot(),
		gitChanges: new Slot(),
		gitAfter: new Slot(),
		errors: new Slot(),
		warns: new Slot(),
		infos: new Slot(),
		after: new Slot(),
	};

	user = {
		before: new Slot(),
		beforePrompt: new Slot(),
		promptBefore: new Slot(),
		prompt: new Slot(),
		promptAfter: new Slot(),
		afterPrompt: new Slot(),
	};

	assistant = {
		reasoning: new Slot(),
		content: new Slot(),
		meta: new Slot(),
	};

	serialize() {
		return [
			{ role: "system", content: this.#serializeSystemAndContext() },
			{ role: "user", content: this.#serializeUser() },
		];
	}

	toXml() {
		const indent = (str, depth = 1) => {
			if (!str) return "";
			const spaces = "\t".repeat(depth);
			return str
				.split("\n")
				.map((line) => (line.trim() ? spaces + line : ""))
				.join("\n");
		};

		const systemAndContext = this.#serializeSystemAndContext(true);
		const userSection = this.#serializeUser(true);

		return [
			"<turn>",
			systemAndContext,
			userSection,
			"\t<assistant>",
			this.assistant.reasoning.hasContent
				? `\t\t<reasoning_content>\n${indent(this.assistant.reasoning.toString(), 3)}\n\t\t</reasoning_content>`
				: "",
			this.assistant.content.hasContent
				? `\t\t<content>\n${indent(this.assistant.content.toString(), 3)}\n\t\t</content>`
				: "",
			this.assistant.meta.hasContent
				? `\t\t<meta>\n${indent(this.assistant.meta.toString(), 3)}\n\t\t</meta>`
				: "",
			"\t</assistant>",
			"</turn>",
		]
			.filter(Boolean)
			.join("\n");
	}

	#serializeSystemAndContext(isAudit = false) {
		const indentStr = isAudit ? "\t" : "";

		const indent = (str, depth) => {
			const spaces = "\t".repeat(depth);
			return str
				.split("\n")
				.map((line) => (line.trim() ? spaces + line : ""))
				.join("\n");
		};

		const parts = [];

		if (
			this.system.before.hasContent ||
			this.system.content.hasContent ||
			this.system.after.hasContent
		) {
			parts.push(`${indentStr}<system>`);
			if (this.system.before.hasContent)
				parts.push(indent(this.system.before.toString(), isAudit ? 2 : 0));
			if (this.system.content.hasContent)
				parts.push(indent(this.system.content.toString(), isAudit ? 2 : 0));
			if (this.system.after.hasContent)
				parts.push(indent(this.system.after.toString(), isAudit ? 2 : 0));
			parts.push(`${indentStr}</system>`);
		}

		if (this.system.systemAfter.hasContent) {
			parts.push(indent(this.system.systemAfter.toString(), isAudit ? 1 : 0));
		}

		if (this.context.before.hasContent) {
			parts.push(indent(this.context.before.toString(), isAudit ? 1 : 0));
		}

		const ctxInner = [
			this.context.filesBefore.hasContent
				? indent(this.context.filesBefore.toString(), isAudit ? 2 : 0)
				: "",
			this.context.files.serializeFiles(isAudit ? "\t\t" : ""),
			this.context.filesAfter.hasContent
				? indent(this.context.filesAfter.toString(), isAudit ? 2 : 0)
				: "",
			this.context.gitBefore.hasContent
				? indent(this.context.gitBefore.toString(), isAudit ? 2 : 0)
				: "",
			this.#serializeGit(isAudit ? "\t\t" : ""),
			this.context.gitAfter.hasContent
				? indent(this.context.gitAfter.toString(), isAudit ? 2 : 0)
				: "",
			this.#serializeMessages(
				"error",
				this.context.errors,
				isAudit ? "\t\t" : "",
			),
			this.#serializeMessages(
				"warn",
				this.context.warns,
				isAudit ? "\t\t" : "",
			),
			this.#serializeMessages(
				"info",
				this.context.infos,
				isAudit ? "\t\t" : "",
			),
		]
			.filter(Boolean)
			.join("\n");

		if (ctxInner) {
			parts.push(`${indentStr}<context>`);
			parts.push(ctxInner);
			parts.push(`${indentStr}</context>`);
		}

		if (this.context.after.hasContent) {
			parts.push(indent(this.context.after.toString(), isAudit ? 1 : 0));
		}

		return parts.join("\n");
	}

	#serializeUser(isAudit = false) {
		const indentStr = isAudit ? "\t" : "";
		const indent = (str, depth) => {
			const spaces = "\t".repeat(depth);
			return str
				.split("\n")
				.map((line) => (line.trim() ? spaces + line : ""))
				.join("\n");
		};

		const parts = [];

		if (this.user.before.hasContent) {
			parts.push(indent(this.user.before.toString(), isAudit ? 1 : 0));
		}

		const userInner = [
			this.user.beforePrompt.hasContent
				? indent(this.user.beforePrompt.toString(), isAudit ? 2 : 0)
				: "",
			`${isAudit ? "\t\t" : ""}<ask>`,
			this.user.promptBefore.hasContent
				? indent(this.user.promptBefore.toString(), isAudit ? 3 : 0)
				: "",
			this.user.prompt.hasContent
				? indent(this.user.prompt.toString(), isAudit ? 3 : 0)
				: "",
			this.user.promptAfter.hasContent
				? indent(this.user.promptAfter.toString(), isAudit ? 3 : 0)
				: "",
			`${isAudit ? "\t\t" : ""}</ask>`,
			this.user.afterPrompt.hasContent
				? indent(this.user.afterPrompt.toString(), isAudit ? 2 : 0)
				: "",
		]
			.filter(Boolean)
			.join("\n");

		if (userInner) {
			parts.push(`${indentStr}<user>`);
			parts.push(userInner);
			parts.push(`${indentStr}</user>`);
		}

		if (this.user.afterPrompt.hasContent) {
			parts.push(indent(this.user.afterPrompt.toString(), isAudit ? 1 : 0));
		}

		return parts.join("\n");
	}

	#serializeGit(indentStr = "") {
		const content = this.context.gitChanges.toString();
		if (!content) return "";
		const indented = content
			.split("\n")
			.map((line) => (line.trim() ? `${indentStr}\t${line}` : ""))
			.join("\n");
		return `${indentStr}<git_changes>\n${indented}\n${indentStr}</git_changes>`;
	}

	#serializeMessages(tag, slot, indentStr = "") {
		const fragments = slot.fragments;
		if (fragments.length === 0) return "";
		return fragments
			.map((f) => `${indentStr}<${tag}>${f.content}</${tag}>`)
			.join("\n");
	}
}
