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

		it("parses set with SEARCH/REPLACE marker pair", () => {
			const input = `<set path="src/config.js"><<SEARCH
const port = 3000;
SEARCH
<<REPLACE
const port = 8080;
REPLACE</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].name, "set");
			assert.strictEqual(commands[0].path, "src/config.js");
			assert.strictEqual(commands[0].operations.length, 1);
			assert.strictEqual(commands[0].operations[0].op, "search_replace");
			assert.strictEqual(
				commands[0].operations[0].search,
				"const port = 3000;",
			);
			assert.strictEqual(
				commands[0].operations[0].replace,
				"const port = 8080;",
			);
		});

		it("parses set with multiple SEARCH/REPLACE pairs", () => {
			const input = `<set path="src/config.js"><<SEARCH
const port = 3000;
SEARCH
<<REPLACE
const port = 8080;
REPLACE
<<SEARCH
const host = "localhost";
SEARCH
<<REPLACE
const host = "0.0.0.0";
REPLACE</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].operations.length, 2);
			assert.strictEqual(commands[0].operations[0].op, "search_replace");
			assert.strictEqual(commands[0].operations[1].op, "search_replace");
		});

		it("parses set with raw body (create / overwrite)", () => {
			const input = '<set path="src/new.js">export default {};</set>';
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].path, "src/new.js");
			assert.strictEqual(commands[0].body, "export default {};");
			assert.ok(!commands[0].operations);
		});

		it("parses set with NEW marker (explicit creation)", () => {
			const input = `<set path="src/new.js"><<NEW
export default {};
NEW</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].operations.length, 1);
			assert.strictEqual(commands[0].operations[0].op, "new");
			assert.strictEqual(
				commands[0].operations[0].content,
				"export default {};",
			);
		});

		it("parses set with APPEND marker", () => {
			const input = `<set path="known://plan"><<APPEND
- [ ] new task
APPEND</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].operations[0].op, "append");
			assert.strictEqual(commands[0].operations[0].content, "- [ ] new task");
		});

		it("parses set with DELETE marker", () => {
			const input = `<set path="src/main.go"><<DELETE
deprecated_function()
DELETE</set>`;
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands[0].operations[0].op, "delete");
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

		it("parses get with manifest flag", () => {
			const { commands } = XmlParser.parse('<get path="src/*.js" manifest/>');
			assert.strictEqual(commands[0].path, "src/*.js");
			assert.notStrictEqual(commands[0].manifest, undefined);
		});

		it("ignores unknown keys attribute (no backward compat)", () => {
			const { commands } = XmlParser.parse('<get path="src/*.js" keys/>');
			assert.strictEqual(commands[0].manifest, undefined);
		});

		// Observed in rummy_dev.db::test:demo (gemma): model correctly
		// identified budget pressure, read getDoc's partial-read
		// examples, and emitted `<get path="..." limit="1000"/>`. Parser
		// silently dropped `limit`, handler fell through to full-
		// promotion branch, 1194-token page re-promoted, budget
		// demoted, strike. Model self-regulated; parser sabotaged.
		// getDoc advertises line/limit — they MUST reach the handler.
		it("parses get with line and limit (partial-read attrs must survive parsing)", () => {
			const { commands } = XmlParser.parse(
				'<get path="src/agent/AgentLoop.js" line="644" limit="80"/>',
			);
			assert.strictEqual(commands[0].path, "src/agent/AgentLoop.js");
			assert.strictEqual(
				commands[0].line,
				"644",
				"line= must reach the handler",
			);
			assert.strictEqual(
				commands[0].limit,
				"80",
				"limit= must reach the handler",
			);
		});

		it("parses get with negative line (tail idiom)", () => {
			const { commands } = XmlParser.parse(
				'<get path="sh://turn_3/npm_test_1" line="-50"/>',
			);
			assert.strictEqual(commands[0].line, "-50");
		});

		it("parses get with limit only", () => {
			const { commands } = XmlParser.parse(
				'<get path="https://example.com/page" limit="1000"/>',
			);
			assert.strictEqual(commands[0].limit, "1000");
		});

		it("parses rm with pass-through attributes (mirrors get)", () => {
			const { commands } = XmlParser.parse(
				'<rm path="known://x" body="pattern-match"/>',
			);
			assert.strictEqual(commands[0].path, "known://x");
			assert.strictEqual(commands[0].body, "pattern-match");
		});

		// mvDoc advertises `<mv path="known://..." visibility="summarized"/>`
		// for batch visibility flips. Parser was silently dropping the
		// visibility attr before. mv.js's VALID also used stale
		// pre-migration terminology; both fixed together.
		it("parses mv with visibility (batch visibility-in-place form)", () => {
			const { commands } = XmlParser.parse(
				'<mv path="known://project/*" visibility="summarized"/>',
			);
			assert.strictEqual(commands[0].path, "known://project/*");
			assert.strictEqual(
				commands[0].visibility,
				"summarized",
				"visibility must reach the handler for batch demote",
			);
			assert.strictEqual(commands[0].to, null, "no destination on in-place");
		});

		it("parses cp with visibility pass-through", () => {
			const { commands } = XmlParser.parse(
				'<cp path="known://a">known://b</cp>',
			);
			assert.strictEqual(commands[0].path, "known://a");
			assert.strictEqual(commands[0].to, "known://b");
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

		it("unclosed tag with a clean sibling tail recovers the siblings", () => {
			// `</unknown>` after `<rm ...>` is not a matching close, so
			// the rm body is unclosed. With no same-name nesting in the
			// body, tail recovery extracts the trailing `<update>` and
			// `<search>` as proper top-level siblings rather than
			// trapping them in the rm body. Otherwise the verdict layer
			// would incorrectly report "no <update> emitted" when an
			// <update> is right there in the packet.
			const input = `<rm path="unknown://foo"></unknown>
<update>Starting research.</update>
<search>Mitch Hedberg cultural impact</search>`;
			const { commands, warnings } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 3);
			assert.strictEqual(commands[0].name, "rm");
			assert.strictEqual(commands[1].name, "update");
			assert.strictEqual(commands[2].name, "search");
			assert.ok(
				warnings.some((w) => w.includes("Unclosed") && w.includes("recovered")),
			);
		});

		it("botched SEARCH/REPLACE without </set> recovers trailing <sh>/<update>", () => {
			// Reduction of a real model failure pattern: a `<set>` whose
			// body botches its edit shape AND lacks the `</set>` tail.
			// Without recovery the trailing `<sh>` and `<update>` get
			// trapped in the unclosed body; the verdict
			// reports a missing `<update>` even though one was emitted.
			const input = `<set path="known://plan">
- [ ] go.mod w/ deps
=======
- [x] go.mod w/ deps
>>>>>>> REPLACE
<sh>chmod +x ./compile.sh && ./compile.sh</sh>
<update status="102">go.mod created; deps ready</update>`;
			const { commands, warnings } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 3);
			assert.strictEqual(commands[0].name, "set");
			assert.strictEqual(commands[1].name, "sh");
			assert.strictEqual(commands[2].name, "update");
			assert.strictEqual(commands[2].status, 102);
			assert.ok(
				warnings.some((w) => w.includes("Unclosed") && w.includes("recovered")),
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

		it("non-keyword marker IDENT preserves arbitrary content including </set> literals", () => {
			const input = [
				'<set path="docs.md"><<EOF',
				"# Heading",
				"Tag examples: <env>x</env>, <set path='y'>z</set>",
				"Even </set> in prose is opaque inside the marker.",
				"EOF</set>",
			].join("\n");
			const { commands, warnings } = XmlParser.parse(input);
			assert.strictEqual(
				commands.length,
				1,
				"single command, no premature close",
			);
			assert.strictEqual(commands[0].name, "set");
			assert.strictEqual(commands[0].path, "docs.md");
			assert.strictEqual(commands[0].operations[0].op, "replace");
			assert.ok(
				commands[0].operations[0].content.includes("</set> in prose is opaque"),
				"literal </set> inside marker is content",
			);
			assert.ok(
				commands[0].operations[0].content.includes("<env>x</env>"),
				"tag examples inside marker are content",
			);
			assert.deepEqual(warnings, [], "no Unclosed/Mismatched warnings");
		});

		it("custom IDENT (any non-keyword identifier) routes to REPLACE", () => {
			const input = [
				'<set path="x.md"><<MARKER_42',
				"content with EOF and END as words but they aren't the closer",
				"MARKER_42</set>",
			].join("\n");
			const { commands } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].operations[0].op, "replace");
			assert.match(
				commands[0].operations[0].content,
				/content with EOF and END/,
			);
		});

		it("packet-shape `<<:::path` falls through to plain-body REPLACE", () => {
			// Edit syntax is bare-only (`<<IDENT...IDENT`). The engine's
			// packet-rendering shape (`<<:::path...:::path`) is engine-emit
			// only — a body echoing it from a model becomes literal content
			// for plain-body REPLACE, with the markers preserved verbatim.
			// Tag-shaped content inside is still opaque to body scanning
			// because XmlParser.skipEditMarker recognizes both shapes.
			const input = [
				'<set path="OC_RIVERS.md"><<:::OC_RIVERS.md',
				"# Hydrology",
				"<env>x</env> stays opaque to set body scanner",
				":::OC_RIVERS.md</set>",
			].join("\n");
			const { commands, warnings } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 1);
			assert.ok(!commands[0].operations, "no edit-syntax ops");
			assert.match(commands[0].body, /<<:::OC_RIVERS\.md/);
			assert.match(commands[0].body, /# Hydrology/);
			assert.deepEqual(warnings, []);
		});

		it("opus-regression: markdown documentation table inside marker body", () => {
			// Reproduction of the opus failure case under the marker family.
			// The markdown table has unclosed `<ask_user>` and stray `</mv>`
			// references; under marker opacity none of them are tokens.
			const input = [
				'<set path="OPUS_ANALYSIS.md"><<DOC',
				"# rummy commands",
				"| `<env/>` | `<env>git log</env>` |",
				'| `<ask_user/>` | `<ask_user question="Which?">` |',
				'| `<mv/>` | `<mv path="known://draft">known://final</mv>` |',
				"DOC</set>",
				'<update status="200">notes written</update>',
			].join("\n");
			const { commands, warnings } = XmlParser.parse(input);
			assert.strictEqual(commands.length, 2, "set + update");
			assert.strictEqual(commands[0].path, "OPUS_ANALYSIS.md");
			assert.ok(
				commands[0].operations[0].content.includes(
					'<mv path="known://draft">known://final</mv>',
				),
				"full table preserved in marker content",
			);
			assert.strictEqual(commands[1].body, "notes written");
			assert.deepEqual(warnings, []);
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
