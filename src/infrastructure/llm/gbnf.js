/**
 * Generates a GBNF grammar from a JSON schema with an optional <think> preamble.
 * Supports: object, array, string (with enum/minLength), boolean, number, integer.
 */

const WS = 'ws ::= [ \\t\\n\\r]*\n';
const JSON_STRING = `json-string ::= "\\"" json-chars "\\""\njson-chars ::= "" | json-char json-chars\njson-char ::= [^"\\\\\\x00-\\x1f] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F]{4}\n`;
const JSON_NUMBER = 'json-number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?\n';
const JSON_BOOL = 'json-bool ::= "true" | "false"\n';

export default function schemaToGbnf(schema, { thinking = false } = {}) {
	const rules = new Map();
	let counter = 0;
	const name = (prefix) => `${prefix}-${counter++}`;

	const emitRule = (ruleName, body) => {
		rules.set(ruleName, body);
		return ruleName;
	};

	const compileSchema = (s, prefix = "val") => {
		if (s.enum) {
			const alts = s.enum.map((v) => `"\\"${v}\\""`).join(" | ");
			return emitRule(name(prefix), alts);
		}

		if (s.type === "string") {
			return "json-string";
		}

		if (s.type === "number" || s.type === "integer") {
			return "json-number";
		}

		if (s.type === "boolean") {
			return "json-bool";
		}

		if (s.type === "array") {
			const itemRule = s.items ? compileSchema(s.items, `${prefix}-item`) : "json-string";
			const arrName = name(prefix);
			emitRule(arrName, `"[" ws (${itemRule} ("," ws ${itemRule})*)? ws "]"`);
			return arrName;
		}

		if (s.type === "object") {
			const required = new Set(s.required || []);
			const props = Object.entries(s.properties || {});
			const objName = name(prefix);

			if (props.length === 0) {
				emitRule(objName, '"{" ws "}"');
				return objName;
			}

			const fields = props.map(([key, propSchema]) => {
				const valRule = compileSchema(propSchema, key);
				return { key, valRule, optional: !required.has(key) };
			});

			const requiredFields = fields.filter((f) => !f.optional);
			const optionalFields = fields.filter((f) => f.optional);

			let body = requiredFields
				.map((f) => `"\\"${f.key}\\"" ws ":" ws ${f.valRule}`)
				.join(' "," ws ');

			for (const f of optionalFields) {
				const optName = name("opt");
				emitRule(optName, `("," ws "\\"${f.key}\\"" ws ":" ws ${f.valRule})?`);
				body += ` ${optName}`;
			}

			emitRule(objName, `"{" ws ${body} ws "}"`);
			return objName;
		}

		return "json-string";
	};

	const rootJsonRule = compileSchema(schema, "root");

	let grammar = "";
	if (thinking) {
		grammar += 'root ::= think ws ' + rootJsonRule + '\n';
		grammar += 'think ::= "<think>" think-body "</think>"\n';
		grammar += 'think-body ::= think-char*\n';
		grammar += 'think-char ::= [^<] | "<" [^/] | "</" [^t] | "</t" [^h] | "</th" [^i] | "</thi" [^n] | "</thin" [^k] | "</think" [^>]\n';
	} else {
		grammar += 'root ::= ' + rootJsonRule + '\n';
	}

	grammar += WS;
	grammar += JSON_STRING;
	grammar += JSON_NUMBER;
	grammar += JSON_BOOL;

	for (const [ruleName, body] of rules) {
		grammar += `${ruleName} ::= ${body}\n`;
	}

	return grammar;
}
