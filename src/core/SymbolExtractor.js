import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import HTML from "tree-sitter-html";
import CSS from "tree-sitter-css";

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
		// Use only the node types as captures. 
		// No field labels, no nested structures.
		this.#queries.js = new Parser.Query(JavaScript, `
(class_declaration) @class
(function_declaration) @function
(method_definition) @method
    `.trim());

		this.#queries.ts = new Parser.Query(TypeScript.typescript, `
(class_declaration) @class
(function_declaration) @function
(method_definition) @method
    `.trim());

		this.#queries.tsx = new Parser.Query(TypeScript.tsx, `
(class_declaration) @class
(function_declaration) @function
(method_definition) @method
    `.trim());

		this.#queries.html = new Parser.Query(HTML, `
(element) @tag
    `.trim());

		this.#queries.css = new Parser.Query(CSS, `
(class_selector) @class
(id_selector) @id
    `.trim());
	}

	/**
	 * Extracts symbols using Tree-sitter.
	 */
	extract(content, ext) {
		const lang = this.#grammars[ext];
		const query = this.#queries[ext];

		if (!lang || !query) return null;

		try {
			this.#parser.setLanguage(lang);
			const tree = this.#parser.parse(content);
			const captures = query.captures(tree.rootNode);

			return captures.map((c) => {
				// Search for an 'identifier' or 'property_identifier' child 
				// to find the actual name.
				let name = "unknown";
				
				for (let i = 0; i < c.node.childCount; i++) {
					const child = c.node.child(i);
					if (["identifier", "property_identifier", "tag_name", "class_name", "id_name"].includes(child.type)) {
						name = child.text;
						break;
					}
				}

				return {
					type: c.name,
					name,
					line: c.node.startPosition.row + 1,
				};
			});
		} catch (err) {
			console.error(`HD Symbol extraction failed for .${ext}:`, err);
			return null;
		}
	}
}
