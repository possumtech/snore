import assert from "node:assert";
import { describe, it } from "node:test";
import XmlParser from "./XmlParser.js";

describe("XmlParser", () => {
	describe("well-formed", () => {
		it("parses summary", () => {
			const { commands } = XmlParser.parse(
				'<update status="200">The answer is 42.</update>',
			);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "update");
			assert.strictEqual(commands[0].body, "The answer is 42.");
		});

		it("parses set with unknown path", () => {
			const { commands } = XmlParser.parse(
				'<set path="unknown://session_store">which session store</set>',
			);
			assert.strictEqual(commands[0].name, "set");
			assert.strictEqual(commands[0].body, "which session store");
		});

		it("parses set with path", () => {
			const { commands } = XmlParser.parse(
				'<set path="/:known:auth">OAuth2 PKCE</set>',
			);
			assert.strictEqual(commands[0].name, "set");
			assert.strictEqual(commands[0].path, "/:known:auth");
			assert.strictEqual(commands[0].body, "OAuth2 PKCE");
		});

		it("parses self-closing get", () => {
			const { commands } = XmlParser.parse('<get path="src/config.js"/>');
			assert.strictEqual(commands[0].name, "get");
			assert.strictEqual(commands[0].path, "src/config.js");
		});

		it("parses self-closing rm", () => {
			const { commands } = XmlParser.parse('<rm path="src/old.js"/>');
			assert.strictEqual(commands[0].name, "rm");
			assert.strictEqual(commands[0].path, "src/old.js");
		});

		it("parses sh command", () => {
			const { commands } = XmlParser.parse('<sh command="npm test"/>');
			assert.strictEqual(commands[0].name, "sh");
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

		it("parses set with search/replace block", () => {
			const input = `<set path="src/config.js">
<<<<<<< SEARCH
const port = 3000;
=======
const port = 8080;
>>>>>>> REPLACE
</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].name, "set");
			assert.strictEqual(commands[0].path, "src/config.js");
			assert.strictEqual(commands[0].blocks.length, 1);
			assert.strictEqual(commands[0].blocks[0].search, "const port = 3000;");
			assert.strictEqual(commands[0].blocks[0].replace, "const port = 8080;");
		});

		it("parses set with multiple merge blocks", () => {
			const input = `<set path="src/config.js">
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
</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].blocks.length, 2);
		});

		it("parses merge with flexible marker length", () => {
			const input = `<set path="src/app.js">
<<<<< SEARCH
old
=====
new
>>>>> REPLACE
</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].blocks.length, 1);
			assert.strictEqual(commands[0].blocks[0].search, "old");
			assert.strictEqual(commands[0].blocks[0].replace, "new");
		});

		it("parses set for new file (replace only)", () => {
			const input = `<set path="src/new.js">
=======
export default {};
>>>>>>> REPLACE
</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].blocks[0].search, null);
			assert.strictEqual(commands[0].blocks[0].replace, "export default {};");
		});

		it("parses multiple commands in one response", () => {
			const input = `<get path="src/config.js"/>
<set path="unknown://database_adapter">which database adapter</set>
<set path="/:known:framework">Express with passport</set>
<update status="200">Reading config to check port.</update>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 4);
			assert.strictEqual(commands[0].name, "get");
			assert.strictEqual(commands[1].name, "set");
			assert.strictEqual(commands[2].name, "set");
			assert.strictEqual(commands[3].name, "update");
		});

		it("parses get with body filter", () => {
			const { commands } = XmlParser.parse('<get path="*.js" body="TODO"/>');
			assert.strictEqual(commands[0].path, "*.js");
			assert.strictEqual(commands[0].body, "TODO");
		});

		it("parses get with preview flag", () => {
			const { commands } = XmlParser.parse('<get path="src/*.js" preview/>');
			assert.strictEqual(commands[0].path, "src/*.js");
			assert.notStrictEqual(commands[0].preview, undefined);
		});

		it("ignores unknown keys attribute (no backward compat)", () => {
			const { commands } = XmlParser.parse('<get path="src/*.js" keys/>');
			assert.strictEqual(commands[0].preview, undefined);
		});

		it("parses set with search/replace attributes", () => {
			const { commands } = XmlParser.parse(
				'<set path="src/*.js" search="localhost" replace="0.0.0.0"/>',
			);
			assert.strictEqual(commands[0].search, "localhost");
			assert.strictEqual(commands[0].replace, "0.0.0.0");
			assert.strictEqual(commands[0].path, "src/*.js");
			assert.ok(!commands[0].blocks);
		});

		it("set: search attr with body as replace", () => {
			const { commands } = XmlParser.parse(
				'<set path="config.js" search="3000">8080</set>',
			);
			assert.strictEqual(commands[0].search, "3000");
			assert.strictEqual(commands[0].replace, "8080");
		});

		it("set: search attr with replace attr takes precedence over body", () => {
			const { commands } = XmlParser.parse(
				'<set path="x.js" search="old" replace="new">ignored</set>',
			);
			assert.strictEqual(commands[0].replace, "new");
		});

		it("parses mv with from and to", () => {
			const { commands } = XmlParser.parse(
				'<mv path="known://env_vars" to=".env"/>',
			);
			assert.strictEqual(commands[0].name, "mv");
			assert.strictEqual(commands[0].path, "known://env_vars");
			assert.strictEqual(commands[0].to, ".env");
		});

		it("parses cp with from and to", () => {
			const { commands } = XmlParser.parse(
				'<cp path=".env" to="known://env_snapshot"/>',
			);
			assert.strictEqual(commands[0].name, "cp");
			assert.strictEqual(commands[0].path, ".env");
			assert.strictEqual(commands[0].to, "known://env_snapshot");
		});

		it("mv: to in body", () => {
			const { commands } = XmlParser.parse(
				'<mv path="src/old.js">src/new.js</mv>',
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
		it("get: body as path", () => {
			const { commands } = XmlParser.parse("<get>src/app.js</get>");
			assert.strictEqual(commands[0].path, "src/app.js");
		});

		it("rm: body as path", () => {
			const { commands } = XmlParser.parse("<rm>src/old.js</rm>");
			assert.strictEqual(commands[0].path, "src/old.js");
		});

		it("set: body in attr (self-closing)", () => {
			const { commands } = XmlParser.parse(
				'<set path="/:known:auth" body="OAuth2"/>',
			);
			assert.strictEqual(commands[0].path, "/:known:auth");
			assert.strictEqual(commands[0].body, "OAuth2");
		});

		it("set unknown: body in attr", () => {
			const { commands } = XmlParser.parse(
				'<set path="unknown://auth_flow" body="what is the auth flow?"/>',
			);
			assert.strictEqual(commands[0].body, "what is the auth flow?");
		});

		it("summary: body in attr", () => {
			const { commands } = XmlParser.parse(
				'<update status="200" body="did the thing"/>',
			);
			assert.strictEqual(commands[0].body, "did the thing");
		});

		it("sh: body as command", () => {
			const { commands } = XmlParser.parse("<sh>npm test</sh>");
			assert.strictEqual(commands[0].command, "npm test");
		});

		it("env: body as command", () => {
			const { commands } = XmlParser.parse("<env>ls -la src/</env>");
			assert.strictEqual(commands[0].command, "ls -la src/");
		});

		it("ask_user: body as options", () => {
			const { commands } = XmlParser.parse(
				'<ask_user question="Which database?">PG, SQLite, MySQL</ask_user>',
			);
			assert.strictEqual(commands[0].question, "Which database?");
			assert.strictEqual(commands[0].options, "PG, SQLite, MySQL");
		});
	});

	describe("malformed", () => {
		it("captures unclosed summary", () => {
			const { commands, warnings } = XmlParser.parse(
				'<update status="200">The answer is 42.',
			);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].body, "The answer is 42.");
			assert.ok(warnings.some((w) => w.includes("Unclosed")));
		});

		it("captures unclosed set", () => {
			const { commands, warnings } = XmlParser.parse(
				'<set path="/:known:x">some value',
			);
			assert.strictEqual(commands[0].path, "/:known:x");
			assert.strictEqual(commands[0].body, "some value");
			assert.ok(warnings.length > 0);
		});

		it("handles get without self-closing slash", () => {
			const { commands } = XmlParser.parse('<get path="src/app.js">');
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].path, "src/app.js");
		});

		it("handles mixed text and commands", () => {
			const input = `Let me think about this...
<get path="src/config.js"/>
I need to check the port.
<update status="200">Checking config.</update>`;
			const { commands, unparsed } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 2);
			assert.ok(unparsed.includes("Let me think about this"));
			assert.ok(unparsed.includes("I need to check the port"));
		});

		it("recovers from mismatched close tag (empty body)", () => {
			const input = `<rm path="unknown://foo"></unknown>
<update>Starting research.</update>
<search>Mitch Hedberg cultural impact</search>`;
			const { commands, warnings } = XmlParser.parse(input);
			assert.strictEqual(
				commands.length,
				3,
				`expected 3 commands, got ${commands.length}: ${commands.map((c) => c.name)}`,
			);
			assert.strictEqual(commands[0].name, "rm");
			assert.strictEqual(commands[1].name, "update");
			assert.strictEqual(commands[2].name, "search");
			assert.ok(
				warnings.some(
					(w) => w.includes("Unclosed") || w.includes("Mismatched"),
				),
			);
		});

		it("recovers from mismatched close tag (with body content)", () => {
			const input =
				`<set path="known://task_plan" summary="plan">- [x] find codename\n- [x] reply</set>
<set path="known://project_info" summary="codename">The project codename is: phoenix</set>
<rm path="unknown://project_codename"/>
<update status="200">phoenix</update>`.replace(
					"</set>\n<set",
					"</update>\n<set",
				);
			const { commands, warnings } = XmlParser.parse(input);
			assert.strictEqual(
				commands.length,
				4,
				`expected 4 commands, got ${commands.length}: ${commands.map((c) => c.name)}`,
			);
			assert.strictEqual(commands[0].name, "set");
			assert.strictEqual(commands[0].path, "known://task_plan");
			assert.strictEqual(commands[1].name, "set");
			assert.strictEqual(commands[1].path, "known://project_info");
			assert.strictEqual(commands[2].name, "rm");
			assert.strictEqual(commands[3].name, "update");
			assert.strictEqual(commands[3].body, "phoenix");
			assert.ok(
				warnings.some(
					(w) => w.includes("Mismatched") && w.includes("corrected"),
				),
			);
		});

		it("ignores tool tags inside markdown code spans", () => {
			const input = [
				"Required: YOU MUST promote entries with `<get/>` to verify.",
				'<update status="200">done</update>',
			].join("\n");
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(
				commands.length,
				1,
				"only the update, not the backtick-quoted get",
			);
			assert.strictEqual(commands[0].name, "update");
			assert.strictEqual(commands[0].body, "done");
		});

		it("preserves legitimate nested tool tags in body text", () => {
			const input = `<set path="known://plan" summary="plan,steps">checklist:
- use <get path="data.txt"/> to read
- use <set> for writes
</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(
				commands.length,
				1,
				"one command, nested tags are body",
			);
			assert.strictEqual(commands[0].name, "set");
			assert.ok(commands[0].body.includes("<get"));
		});

		it("normalizes native tool call format", () => {
			const input = `<|tool_call>call:search{query:"Mass Effect 1 release date"}<tool_call|>
<update>Searching.</update>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(commands[0].name, "search");
			assert.strictEqual(commands[0].path, "Mass Effect 1 release date");
			assert.strictEqual(commands[1].name, "update");
		});

		it("normalizes OpenAI function_call format", () => {
			const input = `{"name":"search","arguments":{"query":"test query"}}
<update>Searching.</update>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(commands[0].name, "search");
			assert.strictEqual(commands[0].path, "test query");
		});

		it("normalizes Anthropic tool_use format", () => {
			const input = `<tool_use>
<name>search</name>
<input>{"query":"Mitch Hedberg"}</input>
</tool_use>
<update>Searching.</update>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(commands[0].name, "search");
			assert.strictEqual(commands[0].path, "Mitch Hedberg");
		});

		it("normalizes Mistral TOOL_CALLS format", () => {
			const input = `[TOOL_CALLS] [{"name":"search","arguments":{"query":"test"}}]
<update>Searching.</update>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(commands[0].name, "search");
			assert.strictEqual(commands[0].path, "test");
		});

		it("ignores native tool calls for unknown tools", () => {
			const input = `<|tool_call>call:fakeTool{arg:"value"}<tool_call|>
<update status="200">Done.</update>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "update");
		});

		it("ignores unknown tags", () => {
			const input = `<thinking>internal thoughts</thinking>
<update status="200">The answer.</update>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "update");
		});
	});

	describe("tag preservation in bodies", () => {
		it("preserves HTML attributes on non-tool tags", () => {
			const { commands } = XmlParser.parse(
				'<set path="test.html"><div class="foo" id="bar">hello</div></set>',
			);
			assert.ok(commands[0].body.includes('class="foo"'));
			assert.ok(commands[0].body.includes('id="bar"'));
		});

		it("preserves Vue/JSX template attributes", () => {
			const { commands } = XmlParser.parse(
				'<set path="App.vue"><template v-if="show"><span :class="active">yes</span></template></set>',
			);
			assert.ok(commands[0].body.includes('v-if="show"'));
			assert.ok(commands[0].body.includes(':class="active"'));
		});

		it("preserves img src and alt attributes", () => {
			const { commands } = XmlParser.parse(
				'<set path="index.html"><img src="photo.png" alt="a photo"/></set>',
			);
			assert.ok(commands[0].body.includes('src="photo.png"'));
			assert.ok(commands[0].body.includes('alt="a photo"'));
		});

		it("preserves nested tags with mixed attributes", () => {
			const { commands } = XmlParser.parse(
				'<set path="page.html"><div data-state="active"><a href="/home" target="_blank">Home</a></div></set>',
			);
			assert.ok(commands[0].body.includes('data-state="active"'));
			assert.ok(commands[0].body.includes('href="/home"'));
			assert.ok(commands[0].body.includes('target="_blank"'));
		});

		it("preserves style tags with attributes", () => {
			const { commands } = XmlParser.parse(
				'<set path="style.html"><style type="text/css">.foo { color: red; }</style></set>',
			);
			assert.ok(commands[0].body.includes('type="text/css"'));
			assert.ok(commands[0].body.includes(".foo { color: red; }"));
		});

		it("preserves boolean attributes", () => {
			const { commands } = XmlParser.parse(
				'<set path="form.html"><input disabled required type="text"/></set>',
			);
			assert.ok(commands[0].body.includes("disabled"));
			assert.ok(commands[0].body.includes("required"));
			assert.ok(commands[0].body.includes('type="text"'));
		});

		it("preserves tags inside set entries", () => {
			const { commands } = XmlParser.parse(
				'<set path="known://html_snippet" summary="html,snippet">The template uses <div class="container"><slot name="header"/></div></set>',
			);
			assert.ok(commands[0].body.includes('class="container"'));
			assert.ok(commands[0].body.includes('name="header"'));
		});

		it("preserves tags inside sh heredocs", () => {
			const { commands } = XmlParser.parse(
				'<sh>cat <<EOF\n<div class="test">content</div>\nEOF</sh>',
			);
			assert.ok(commands[0].command.includes('class="test"'));
		});

		it("preserves angle brackets in plain text context", () => {
			const { commands } = XmlParser.parse(
				'<set path="known://condition">The condition x > 5 && y < 10 is important</set>',
			);
			assert.ok(commands[0].body.includes("> 5"));
		});

		it("preserves multiple nested levels", () => {
			const { commands } = XmlParser.parse(
				'<set path="deep.html"><div id="l1"><div id="l2"><div id="l3">deep</div></div></div></set>',
			);
			assert.ok(commands[0].body.includes('id="l1"'));
			assert.ok(commands[0].body.includes('id="l2"'));
			assert.ok(commands[0].body.includes('id="l3"'));
		});

		it("still parses tool tags correctly amid HTML content", () => {
			const { commands } = XmlParser.parse(
				'<set path="a.html"><div class="x">hello</div></set><get>b.js</get>',
			);
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(commands[0].name, "set");
			assert.ok(commands[0].body.includes('class="x"'));
			assert.strictEqual(commands[1].name, "get");
			assert.strictEqual(commands[1].path, "b.js");
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

	describe("sed syntax", () => {
		it("parses s/search/replace/", () => {
			const { commands } = XmlParser.parse(
				'<set path="config.js">s/3000/8080/</set>',
			);
			assert.strictEqual(commands[0].search, "3000");
			assert.strictEqual(commands[0].replace, "8080");
		});

		it("parses s/search/replace/g", () => {
			const { commands } = XmlParser.parse(
				'<set path="config.js">s/localhost/0.0.0.0/g</set>',
			);
			assert.strictEqual(commands[0].search, "localhost");
			assert.strictEqual(commands[0].replace, "0.0.0.0");
		});

		it("parses s/search/replace without trailing slash", () => {
			const { commands } = XmlParser.parse(
				'<set path="config.js">s/old/new</set>',
			);
			assert.strictEqual(commands[0].search, "old");
			assert.strictEqual(commands[0].replace, "new");
		});

		it("parses sed with spaces in search/replace", () => {
			const { commands } = XmlParser.parse(
				'<set path="hw.txt">s/7 - a = /7 - a = 5/g</set>',
			);
			assert.strictEqual(commands[0].search, "7 - a = ");
			assert.strictEqual(commands[0].replace, "7 - a = 5");
		});

		it("parses sed with empty replace (deletion)", () => {
			const { commands } = XmlParser.parse(
				'<set path="f.js">s/debugger;//</set>',
			);
			assert.strictEqual(commands[0].search, "debugger;");
			assert.strictEqual(commands[0].replace, "");
		});

		it("parses chained seds with semicolon", () => {
			const { commands } = XmlParser.parse(
				'<set path="f.js">s/foo/bar/g;s/baz/qux/g</set>',
			);
			assert.strictEqual(commands[0].blocks.length, 2);
			assert.strictEqual(commands[0].blocks[0].search, "foo");
			assert.strictEqual(commands[0].blocks[0].replace, "bar");
			assert.strictEqual(commands[0].blocks[1].search, "baz");
			assert.strictEqual(commands[0].blocks[1].replace, "qux");
		});

		it("parses chained seds with space separator", () => {
			const { commands } = XmlParser.parse(
				'<set path="f.js">s/old/new/ s/foo/bar/</set>',
			);
			assert.strictEqual(commands[0].blocks.length, 2);
			assert.strictEqual(commands[0].blocks[0].search, "old");
			assert.strictEqual(commands[0].blocks[0].replace, "new");
			assert.strictEqual(commands[0].blocks[1].search, "foo");
			assert.strictEqual(commands[0].blocks[1].replace, "bar");
		});

		it("parses chained seds with newline separator", () => {
			const { commands } = XmlParser.parse(
				'<set path="f.js">s/a/b/\ns/c/d/</set>',
			);
			assert.strictEqual(commands[0].blocks.length, 2);
			assert.strictEqual(commands[0].blocks[0].search, "a");
			assert.strictEqual(commands[0].blocks[1].search, "c");
		});

		it("parses sed with escaped slashes", () => {
			const { commands } = XmlParser.parse(
				'<set path="hw.txt">s/b \\/ 4 = 3/12 \\/ 4 = 3/</set>',
			);
			assert.strictEqual(commands[0].search, "b / 4 = 3");
			assert.strictEqual(commands[0].replace, "12 / 4 = 3");
		});

		it("parses chained seds with escaped slashes", () => {
			const { commands } = XmlParser.parse(
				'<set path="hw.txt">s/a + 4 = 6/2 + 4 = 6/ s/b \\/ 4 = 3/12 \\/ 4 = 3/</set>',
			);
			assert.strictEqual(commands[0].blocks.length, 2);
			assert.strictEqual(commands[0].blocks[0].search, "a + 4 = 6");
			assert.strictEqual(commands[0].blocks[1].search, "b / 4 = 3");
			assert.strictEqual(commands[0].blocks[1].replace, "12 / 4 = 3");
		});

		it("parses sed with regex anchors as literal text", () => {
			const { commands } = XmlParser.parse(
				'<set path="hw.txt">s/7 - a =$/7 - a = 5/</set>',
			);
			assert.strictEqual(commands[0].search, "7 - a =$");
			assert.strictEqual(commands[0].replace, "7 - a = 5");
		});
	});

	describe("command cap", () => {
		it("enforces MAX_COMMANDS limit", () => {
			const original = XmlParser.MAX_COMMANDS;
			XmlParser.MAX_COMMANDS = 5;
			try {
				const xml = Array.from(
					{ length: 20 },
					(_, i) => `<get>file_${i}.js</get>`,
				).join("");
				const { commands, warnings } = XmlParser.parse(xml);
				assert.strictEqual(commands.length, 5);
				assert.ok(
					warnings.some((w) => w.includes("limit")),
					"should warn about cap",
				);
			} finally {
				XmlParser.MAX_COMMANDS = original;
			}
		});

		it("allows exactly MAX_COMMANDS", () => {
			const original = XmlParser.MAX_COMMANDS;
			XmlParser.MAX_COMMANDS = 3;
			try {
				const xml = "<get>a.js</get><get>b.js</get><get>c.js</get>";
				const { commands, warnings } = XmlParser.parse(xml);
				assert.strictEqual(commands.length, 3);
				assert.ok(
					!warnings.some((w) => w.includes("limit")),
					"no warning at exact limit",
				);
			} finally {
				XmlParser.MAX_COMMANDS = original;
			}
		});
	});
});
