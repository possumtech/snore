import assert from "node:assert";
import { describe, it } from "node:test";
import XmlParser from "./XmlParser.js";

describe("XmlParser", () => {
	describe("well-formed", () => {
		it("parses summary", () => {
			const { commands } = XmlParser.parse(
				"<summary>The answer is 42.</summary>",
			);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "summary");
			assert.strictEqual(commands[0].value, "The answer is 42.");
		});

		it("parses unknown", () => {
			const { commands } = XmlParser.parse(
				"<unknown>which session store</unknown>",
			);
			assert.strictEqual(commands[0].name, "unknown");
			assert.strictEqual(commands[0].value, "which session store");
		});

		it("parses known with path", () => {
			const { commands } = XmlParser.parse(
				'<known path="/:known:auth">OAuth2 PKCE</known>',
			);
			assert.strictEqual(commands[0].name, "known");
			assert.strictEqual(commands[0].path, "/:known:auth");
			assert.strictEqual(commands[0].value, "OAuth2 PKCE");
		});

		it("parses self-closing read", () => {
			const { commands } = XmlParser.parse('<read path="src/config.js"/>');
			assert.strictEqual(commands[0].name, "read");
			assert.strictEqual(commands[0].path, "src/config.js");
		});

		it("parses self-closing drop", () => {
			const { commands } = XmlParser.parse('<drop path="/:unknown:42"/>');
			assert.strictEqual(commands[0].name, "drop");
			assert.strictEqual(commands[0].path, "/:unknown:42");
		});

		it("parses self-closing delete", () => {
			const { commands } = XmlParser.parse('<delete path="src/old.js"/>');
			assert.strictEqual(commands[0].name, "delete");
			assert.strictEqual(commands[0].path, "src/old.js");
		});

		it("parses run command", () => {
			const { commands } = XmlParser.parse('<run command="npm test"/>');
			assert.strictEqual(commands[0].name, "run");
			assert.strictEqual(commands[0].command, "npm test");
		});

		it("parses env command", () => {
			const { commands } = XmlParser.parse('<env command="ls -la src/"/>');
			assert.strictEqual(commands[0].name, "env");
			assert.strictEqual(commands[0].command, "ls -la src/");
		});

		it("parses ask_user", () => {
			const { commands } = XmlParser.parse(
				'<ask_user question="Which DB?" options="PG, SQLite"/>',
			);
			assert.strictEqual(commands[0].name, "ask_user");
			assert.strictEqual(commands[0].question, "Which DB?");
			assert.strictEqual(commands[0].options, "PG, SQLite");
		});

		it("parses edit with search/replace block", () => {
			const input = `<edit path="src/config.js">
<<<<<<< SEARCH
const port = 3000;
=======
const port = 8080;
>>>>>>> REPLACE
</edit>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].name, "edit");
			assert.strictEqual(commands[0].path, "src/config.js");
			assert.strictEqual(commands[0].blocks.length, 1);
			assert.strictEqual(commands[0].blocks[0].search, "const port = 3000;");
			assert.strictEqual(commands[0].blocks[0].replace, "const port = 8080;");
		});

		it("parses edit with multiple merge blocks", () => {
			const input = `<edit path="src/config.js">
<<<<<<< SEARCH
const port = 3000;
=======
const port = 8080;
>>>>>>> REPLACE
<<<<<<< SEARCH
const host = "localhost";
=======
const host = "0.0.0.0";
>>>>>>> REPLACE
</edit>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].blocks.length, 2);
		});

		it("parses edit for new file (replace only)", () => {
			const input = `<edit path="src/new.js">
=======
export default {};
>>>>>>> REPLACE
</edit>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].blocks[0].search, null);
			assert.strictEqual(commands[0].blocks[0].replace, "export default {};");
		});

		it("parses multiple commands in one response", () => {
			const input = `<read path="src/config.js"/>
<unknown>which database adapter</unknown>
<known path="/:known:framework">Express with passport</known>
<summary>Reading config to check port.</summary>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 4);
			assert.strictEqual(commands[0].name, "read");
			assert.strictEqual(commands[1].name, "unknown");
			assert.strictEqual(commands[2].name, "known");
			assert.strictEqual(commands[3].name, "summary");
		});

		it("parses read with value filter", () => {
			const { commands } = XmlParser.parse('<read path="*.js" value="TODO"/>');
			assert.strictEqual(commands[0].path, "*.js");
			assert.strictEqual(commands[0].value, "TODO");
		});

		it("parses read with keys flag", () => {
			const { commands } = XmlParser.parse('<read path="src/*.js" keys/>');
			assert.strictEqual(commands[0].path, "src/*.js");
			assert.strictEqual(commands[0].keys, true);
		});

		it("parses edit with search/replace attributes", () => {
			const { commands } = XmlParser.parse(
				'<edit path="src/*.js" search="localhost" replace="0.0.0.0"/>',
			);
			assert.strictEqual(commands[0].search, "localhost");
			assert.strictEqual(commands[0].replace, "0.0.0.0");
			assert.strictEqual(commands[0].path, "src/*.js");
			assert.ok(!commands[0].blocks);
		});

		it("edit: search attr with body as replace", () => {
			const { commands } = XmlParser.parse(
				'<edit path="config.js" search="3000">8080</edit>',
			);
			assert.strictEqual(commands[0].search, "3000");
			assert.strictEqual(commands[0].replace, "8080");
		});

		it("edit: search attr with replace attr takes precedence over body", () => {
			const { commands } = XmlParser.parse(
				'<edit path="x.js" search="old" replace="new">ignored</edit>',
			);
			assert.strictEqual(commands[0].replace, "new");
		});

		it("parses move with from and to", () => {
			const { commands } = XmlParser.parse(
				'<move path="known://env_vars" to=".env"/>',
			);
			assert.strictEqual(commands[0].name, "move");
			assert.strictEqual(commands[0].path, "known://env_vars");
			assert.strictEqual(commands[0].to, ".env");
		});

		it("parses copy with from and to", () => {
			const { commands } = XmlParser.parse(
				'<copy path=".env" to="known://env_snapshot"/>',
			);
			assert.strictEqual(commands[0].name, "copy");
			assert.strictEqual(commands[0].path, ".env");
			assert.strictEqual(commands[0].to, "known://env_snapshot");
		});

		it("move: to in body", () => {
			const { commands } = XmlParser.parse(
				'<move path="src/old.js">src/new.js</move>',
			);
			assert.strictEqual(commands[0].to, "src/new.js");
		});

		it("parses search with query", () => {
			const { commands } = XmlParser.parse('<search path="node.js streams"/>');
			assert.strictEqual(commands[0].name, "search");
			assert.strictEqual(commands[0].path, "node.js streams");
		});

		it("search body as query", () => {
			const { commands } = XmlParser.parse("<search>SQLite WAL mode</search>");
			assert.strictEqual(commands[0].path, "SQLite WAL mode");
		});
	});

	describe("alternative philosophies", () => {
		it("read: body as path", () => {
			const { commands } = XmlParser.parse("<read>src/app.js</read>");
			assert.strictEqual(commands[0].path, "src/app.js");
		});

		it("drop: body as path", () => {
			const { commands } = XmlParser.parse("<drop>/:unknown:42</drop>");
			assert.strictEqual(commands[0].path, "/:unknown:42");
		});

		it("delete: body as path", () => {
			const { commands } = XmlParser.parse("<delete>src/old.js</delete>");
			assert.strictEqual(commands[0].path, "src/old.js");
		});

		it("known: value in attr (self-closing)", () => {
			const { commands } = XmlParser.parse(
				'<known path="/:known:auth" value="OAuth2"/>',
			);
			assert.strictEqual(commands[0].path, "/:known:auth");
			assert.strictEqual(commands[0].value, "OAuth2");
		});

		it("unknown: value in attr", () => {
			const { commands } = XmlParser.parse(
				'<unknown value="what is the auth flow?"/>',
			);
			assert.strictEqual(commands[0].value, "what is the auth flow?");
		});

		it("summary: value in attr", () => {
			const { commands } = XmlParser.parse('<summary value="did the thing"/>');
			assert.strictEqual(commands[0].value, "did the thing");
		});

		it("run: body as command", () => {
			const { commands } = XmlParser.parse("<run>npm test</run>");
			assert.strictEqual(commands[0].command, "npm test");
		});

		it("env: body as command", () => {
			const { commands } = XmlParser.parse("<env>ls -la src/</env>");
			assert.strictEqual(commands[0].command, "ls -la src/");
		});

		it("ask_user: body as question", () => {
			const { commands } = XmlParser.parse(
				"<ask_user>Which database?</ask_user>",
			);
			assert.strictEqual(commands[0].question, "Which database?");
		});

		it("legacy key attr resolves to path", () => {
			const { commands } = XmlParser.parse('<read key="src/app.js"/>');
			assert.strictEqual(commands[0].path, "src/app.js");
		});

		it("legacy file attr resolves to path", () => {
			const input = `<edit file="src/config.js">
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
</edit>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].path, "src/config.js");
		});
	});

	describe("malformed", () => {
		it("captures unclosed summary", () => {
			const { commands, warnings } = XmlParser.parse(
				"<summary>The answer is 42.",
			);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].value, "The answer is 42.");
			assert.ok(warnings.some((w) => w.includes("Unclosed")));
		});

		it("captures unclosed known", () => {
			const { commands, warnings } = XmlParser.parse(
				'<known path="/:known:x">some value',
			);
			assert.strictEqual(commands[0].path, "/:known:x");
			assert.strictEqual(commands[0].value, "some value");
			assert.ok(warnings.length > 0);
		});

		it("handles read without self-closing slash", () => {
			const { commands } = XmlParser.parse('<read path="src/app.js">');
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].path, "src/app.js");
		});

		it("handles mixed text and commands", () => {
			const input = `Let me think about this...
<read path="src/config.js"/>
I need to check the port.
<summary>Checking config.</summary>`;
			const { commands, unparsed } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 2);
			assert.ok(unparsed.includes("Let me think about this"));
			assert.ok(unparsed.includes("I need to check the port"));
		});

		it("ignores unknown tags", () => {
			const input = `<thinking>internal thoughts</thinking>
<summary>The answer.</summary>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "summary");
		});
	});

	describe("edge cases", () => {
		it("handles empty content", () => {
			const { commands } = XmlParser.parse("");
			assert.strictEqual(commands.length, 0);
		});

		it("handles null content", () => {
			const { commands } = XmlParser.parse(null);
			assert.strictEqual(commands.length, 0);
		});

		it("handles content with no commands", () => {
			const { commands, unparsed } = XmlParser.parse(
				"Just some text with no XML.",
			);
			assert.strictEqual(commands.length, 0);
			assert.ok(unparsed.includes("Just some text"));
		});
	});
});
