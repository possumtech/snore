import Parser from "tree-sitter";
import CSS from "tree-sitter-css";
import HTML from "tree-sitter-html";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

export default class SymbolExtractor {
	#parser;
	#grammars = {};
	#queries = {};

	constructor() {
		this.#parser = new Parser();

		this.#grammars = {
			js: JavaScript,
			mjs: JavaScript,
			ts: TypeScript.typescript,
			tsx: TypeScript.tsx,
			html: HTML,
			css: CSS,
		};

		this.#setupQueries();
	}

	#setupQueries() {
		const jsQueryStr = `
(class_declaration) @class
(function_declaration) @function
(method_definition) @method
(call_expression) @ref
(new_expression) @ref
    `.trim();

		this.#queries.js = new Parser.Query(JavaScript, jsQueryStr);
		this.#queries.ts = new Parser.Query(TypeScript.typescript, jsQueryStr);
		this.#queries.tsx = new Parser.Query(TypeScript.tsx, jsQueryStr);

		this.#queries.html = new Parser.Query(HTML, `(element) @tag`.trim());

		this.#queries.css = new Parser.Query(
			CSS,
			`
(class_selector) @class
(id_selector) @id
    `.trim(),
		);
	}

	/**
	 * Extracts both definitions and references.
	 */
	extract(content, ext) {
		const lang = this.#grammars[ext];
		const query = this.#queries[ext];

		if (!lang || !query) return null;

		try {
			this.#parser.setLanguage(lang);
			const tree = this.#parser.parse(content);
			const captures = query.captures(tree.rootNode);

			const definitions = [];
			const references = new Set();

			for (const capture of captures) {
				if (
					["class", "function", "method", "tag", "id"].includes(capture.name)
				) {
					let name = "";
					let params = "";
					for (let i = 0; i < capture.node.childCount; i++) {
						const child = capture.node.child(i);
						if (
							[
								"identifier",
								"property_identifier",
								"tag_name",
								"class_name",
								"id_name",
							].includes(child.type)
						) {
							name = child.text;
						} else if (child.type === "formal_parameters") {
							params = child.text;
						}
					}

					if (name) {
						definitions.push({
							type: capture.name,
							name,
							params,
							line: capture.node.startPosition.row + 1,
						});
					}
				} else if (capture.name === "ref") {
					const findIdentifier = (node) => {
						if (
							node.type === "identifier" ||
							node.type === "property_identifier"
						)
							return node.text;
						for (let i = 0; i < node.childCount; i++) {
							const result = findIdentifier(node.child(i));
							if (result) return result;
						}
						return null;
					};
					const refName = findIdentifier(capture.node);
					if (refName) references.add(refName);
				}
			}

			return {
				definitions,
				references: Array.from(references),
			};
		} catch (err) {
			console.error(`HD Symbol extraction failed for .${ext}:`, err);
			return null;
		}
	}
}
