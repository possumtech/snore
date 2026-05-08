// Brutal corpus for XmlParser. Pins the contract regardless of which
// parser implementation is in service. New tests get added here when a
// real-world model output exposes a new failure mode.
import assert from "node:assert";
import { describe, it } from "node:test";
import XmlParser from "./XmlParser.js";

const parse = (input) => XmlParser.parse(input);

const expectOne = (input, name, predicate) => {
	const { commands } = parse(input);
	assert.strictEqual(
		commands.length,
		1,
		`expected one command, got ${commands.length}`,
	);
	assert.strictEqual(commands[0].name, name);
	if (predicate) predicate(commands[0]);
};

describe("XmlParser brutal corpus", () => {
	describe("A. Code content with < or > inside tag bodies", () => {
		it("regex negative lookbehind", () => {
			const input = '<set path="r.txt">(?<![a-zA-Z0-9])\\d+</set>';
			expectOne(input, "set", (c) =>
				assert.ok(
					c.body?.includes("(?<![a-zA-Z0-9])"),
					`body lost lookbehind: ${c.body}`,
				),
			);
		});

		it("regex positive lookbehind", () => {
			const input = '<set path="r.txt">(?<=foo)bar</set>';
			expectOne(input, "set", (c) => assert.ok(c.body?.includes("(?<=foo)")));
		});

		it("regex atomic group", () => {
			const input = '<set path="r.txt">(?>greedy+)</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("(?>greedy+)")),
			);
		});

		it("comparison operators in pseudocode", () => {
			const input = '<set path="x.txt">if x < 10 && y > 5 { ok }</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("x < 10 && y > 5")),
			);
		});

		it("bit-shift operators", () => {
			const input = '<set path="x.c">x = (a << 8) | (b >> 4);</set>';
			expectOne(input, "set", (c) => assert.ok(c.body?.includes("(a << 8)")));
		});

		it("typescript generics", () => {
			const input =
				'<set path="x.ts">const m: Map<string, Vec<i32>> = new Map();</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("Map<string, Vec<i32>>")),
			);
		});

		it("rust generic", () => {
			const input =
				'<set path="x.rs">fn f() -> Result<Vec<u8>, Error> { ok }</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("Result<Vec<u8>, Error>")),
			);
		});

		it("c++ include", () => {
			const input = '<set path="x.cpp">#include <iostream>\nint main(){}</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("#include <iostream>")),
			);
		});

		it("c++ deeply nested template", () => {
			const input =
				'<set path="x.cpp">std::map<int, std::vector<std::string>> m;</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("std::map<int, std::vector<std::string>>")),
			);
		});

		it("jsx fragment in body", () => {
			const input = '<set path="App.jsx">return <div>{x}</div>;</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("<div>{x}</div>")),
			);
		});

		it("html literal in body", () => {
			const input = '<set path="x.html"><a href="y">link</a></set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes('<a href="y">link</a>')),
			);
		});

		it("xml processing instruction in body", () => {
			const input = '<set path="x.xml"><?xml version="1.0"?><root/></set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes('<?xml version="1.0"?>')),
			);
		});

		it("doctype declaration in body", () => {
			const input = '<set path="x.html"><!DOCTYPE html>\n<html></html></set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("<!DOCTYPE html>")),
			);
		});

		it("html comment in body", () => {
			const input = '<set path="x.html"><!-- comment with <stuff> --></set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("<!-- comment with <stuff> -->")),
			);
		});

		it("CDATA section in body", () => {
			const input = '<set path="x.xml"><![CDATA[some <data> here]]></set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("<![CDATA[some <data> here]]>")),
			);
		});

		it("bash redirect", () => {
			const input = "<sh>grep foo bar.txt > out.txt 2>&1</sh>";
			expectOne(input, "sh", (c) =>
				assert.ok(c.command?.includes("> out.txt 2>&1")),
			);
		});

		it("bash heredoc", () => {
			const input = "<sh>cat <<EOF\nhello world\nEOF</sh>";
			expectOne(input, "sh", (c) =>
				assert.ok(c.command?.includes("cat <<EOF")),
			);
		});

		it("markdown blockquote in body", () => {
			const input = '<set path="x.md">> quoted text\n> another line</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("> quoted text")),
			);
		});

		it("email reply quote", () => {
			const input =
				'<set path="reply.txt">> Original message\nResponse here</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("> Original message")),
			);
		});

		it("python type hints with brackets", () => {
			const input =
				'<set path="x.py">def f(items: List[Dict[str, Any]]) -> Optional[int]: ...</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("List[Dict[str, Any]]")),
			);
		});

		it("c-pointer arrow chain", () => {
			const input = '<set path="x.c">x->y->z->value;</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("x->y->z->value")),
			);
		});
	});

	describe("B. Fence and quote variants", () => {
		it("triple-backtick fenced regex with lookbehind", () => {
			const input = [
				'<set path="r.txt">',
				"```",
				"(?<![a-zA-Z0-9])\\d+",
				"```",
				"</set>",
			].join("\n");
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("(?<![a-zA-Z0-9])"), `body=${c.body}`),
			);
		});

		it("triple-backtick fence with language tag", () => {
			const input = [
				'<set path="x.py">',
				"```python",
				"if x < 5: print('y > 3')",
				"```",
				"</set>",
			].join("\n");
			expectOne(input, "set", (c) => assert.ok(c.body?.includes("if x < 5")));
		});

		it("tilde fence", () => {
			const input = [
				'<set path="x.md">',
				"~~~",
				"<html>contents</html>",
				"~~~",
				"</set>",
			].join("\n");
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("<html>contents</html>")),
			);
		});

		it("indented code block", () => {
			const input = [
				'<set path="doc.md">',
				"Description:",
				"",
				"    <example/>",
				"    <another/>",
				"",
				"More text.",
				"</set>",
			].join("\n");
			expectOne(input, "set", (c) => assert.ok(c.body?.includes("<example/>")));
		});

		it("inline backtick code with tag-like content (existing convention)", () => {
			const input = [
				"Required: promote with `<get/>` to verify.",
				'<update status="200">done</update>',
			].join("\n");
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 1, "only the update");
			assert.strictEqual(commands[0].name, "update");
		});

		it("inline backtick with multiple tags", () => {
			const input = [
				"Use `<get/>` and `<set/>` together.",
				'<update status="200">noted</update>',
			].join("\n");
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "update");
		});
	});

	describe("C. Tag boundary edge cases", () => {
		it("self-closing no space", () => {
			expectOne('<get path="a"/>', "get", (c) =>
				assert.strictEqual(c.path, "a"),
			);
		});

		it("self-closing with space", () => {
			expectOne('<get path="a" />', "get", (c) =>
				assert.strictEqual(c.path, "a"),
			);
		});

		it("multi-line opener", () => {
			const input = '<set\n  path="x"\n  visibility="visible"\n>body</set>';
			expectOne(input, "set", (c) => {
				assert.strictEqual(c.path, "x");
				assert.strictEqual(c.body, "body");
			});
		});

		it("tab-heavy attributes", () => {
			const input = '<set\tpath\t=\t"x"\t>body</set>';
			expectOne(input, "set", (c) => assert.strictEqual(c.path, "x"));
		});

		it("CRLF line endings in opener", () => {
			const input = '<set\r\n  path="x"\r\n>body</set>';
			expectOne(input, "set", (c) => assert.strictEqual(c.path, "x"));
		});

		it("no attributes", () => {
			expectOne("<update>done</update>", "update", (c) =>
				assert.strictEqual(c.body, "done"),
			);
		});

		it("boolean-only attribute", () => {
			expectOne('<get path="a" manifest/>', "get", (c) => {
				assert.strictEqual(c.path, "a");
				assert.ok(
					c.manifest === true || c.manifest === "" || c.manifest === "manifest",
				);
			});
		});

		it("multiple boolean attrs", () => {
			const input = '<get path="a" manifest deep/>';
			expectOne(input, "get", (c) => assert.strictEqual(c.path, "a"));
		});
	});

	describe("D. Attribute edge cases", () => {
		it("single-quoted attribute value", () => {
			expectOne("<get path='a'/>", "get", (c) =>
				assert.strictEqual(c.path, "a"),
			);
		});

		it("mixed quote styles in same opener", () => {
			expectOne(`<get path="a" body='b'/>`, "get", (c) => {
				assert.strictEqual(c.path, "a");
				assert.strictEqual(c.body, "b");
			});
		});

		it("empty attribute value (treated as no path)", () => {
			// resolveCommand collapses falsy paths to null via a.path || trimmed
			// || null; empty string is falsy. Round-tripping "" is a separate
			// concern; the parser itself must produce one command without
			// crashing.
			const { commands } = parse('<get path=""/>');
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "get");
		});

		it("whitespace around equals", () => {
			expectOne('<get path = "a" />', "get", (c) =>
				assert.strictEqual(c.path, "a"),
			);
		});

		it("attribute value containing <", () => {
			const input = '<set path="x" summary="x < y">body</set>';
			expectOne(input, "set", (c) => {
				assert.strictEqual(c.path, "x");
				assert.strictEqual(c.summary, "x < y");
			});
		});

		it("attribute value containing >", () => {
			const input = '<set path="x" summary="a > b">body</set>';
			expectOne(input, "set", (c) => assert.strictEqual(c.summary, "a > b"));
		});

		it("attribute value with both < and >", () => {
			const input = '<set path="x" summary="x < y > z">body</set>';
			expectOne(input, "set", (c) =>
				assert.strictEqual(c.summary, "x < y > z"),
			);
		});

		it("attribute value with newline", () => {
			const input = '<set path="x" summary="line1\nline2">body</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.summary?.includes("line1") && c.summary?.includes("line2")),
			);
		});

		it("path with colons (scheme://)", () => {
			expectOne('<get path="known://my:path:here"/>', "get", (c) =>
				assert.strictEqual(c.path, "known://my:path:here"),
			);
		});

		it("path with spaces", () => {
			expectOne('<get path="src/dir name/file.txt"/>', "get", (c) =>
				assert.strictEqual(c.path, "src/dir name/file.txt"),
			);
		});

		it("path with brackets and dollars", () => {
			expectOne('<get path="src/[idx].js"/>', "get", (c) =>
				assert.strictEqual(c.path, "src/[idx].js"),
			);
		});

		it("path with unicode", () => {
			expectOne('<get path="src/файл.js"/>', "get", (c) =>
				assert.strictEqual(c.path, "src/файл.js"),
			);
		});

		it("path with emoji", () => {
			expectOne('<get path="🚀.txt"/>', "get", (c) =>
				assert.strictEqual(c.path, "🚀.txt"),
			);
		});
	});

	describe("E. Body opacity (body content is raw)", () => {
		it("body containing close-of-other-tool tag", () => {
			const input = '<set path="x">uses </get></set>';
			expectOne(input, "set", (c) => assert.ok(c.body?.includes("</get>")));
		});

		it("body containing literal tool-like prose (existing test, kept)", () => {
			const input = `<set path="known://plan" summary="plan,steps">checklist:
- use <get path="data.txt"/> to read
- use <set> for writes
</set>`;
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "set");
		});

		it("genuinely nested same-tag (depth 2)", () => {
			const input = '<set path="outer">A<set path="inner">B</set>C</set>';
			const { commands } = parse(input);
			// At minimum: the outer set must be captured with full nested body literal.
			assert.ok(commands.length >= 1);
			assert.strictEqual(commands[0].name, "set");
			assert.ok(
				commands[0].body?.includes("A") &&
					commands[0].body?.includes('<set path="inner">B</set>') &&
					commands[0].body?.includes("C"),
				`outer body should contain inner verbatim, got: ${commands[0].body}`,
			);
		});

		it("genuinely nested same-tag (depth 3)", () => {
			const input = '<set path="a"><set><set>x</set></set></set>';
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 1);
			assert.ok(commands[0].body?.includes("<set><set>x</set></set>"));
		});

		it("empty body", () => {
			expectOne('<set path="x"></set>', "set");
		});

		it("whitespace-only body", () => {
			expectOne('<set path="x">   \n   </set>', "set");
		});

		it("body with markdown headers", () => {
			const input = '<set path="x.md"># Heading\n## Sub</set>';
			expectOne(input, "set", (c) =>
				assert.ok(c.body?.includes("# Heading") && c.body?.includes("## Sub")),
			);
		});

		it("body with bullet list mentioning tools", () => {
			const input = '<set path="notes">- use <get>\n- use <set></set>';
			// Outer should close at the LAST </set>, body contains tool-like prose.
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "set");
		});
	});

	describe("F. Truncation / recovery", () => {
		it("EOF mid-name does not produce a command", () => {
			const { commands } = parse("<se");
			assert.strictEqual(commands.length, 0);
		});

		it("bare < does not produce a command", () => {
			const { commands } = parse("<");
			assert.strictEqual(commands.length, 0);
		});

		it("EOF after open: body captured, warning emitted", () => {
			const { commands, warnings } = parse('<set path="x">incomplete body');
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "set");
			assert.ok(commands[0].body?.includes("incomplete body"));
			assert.ok(warnings.some((w) => /unclosed/i.test(w)));
		});

		it("EOF mid-attribute name", () => {
			const { commands } = parse("<set pa");
			assert.strictEqual(commands.length, 0);
		});

		it("EOF mid-attribute value", () => {
			const { commands } = parse('<set path="incomplete');
			// Acceptable: 0 commands OR 1 command with recovered path.
			if (commands.length === 1) {
				assert.strictEqual(commands[0].name, "set");
			}
		});

		it("orphan close tag of a known tool", () => {
			const { commands } = parse("text </set> more text");
			assert.strictEqual(commands.length, 0);
			// Warning is optional; outcome must not produce a phantom command.
		});

		it("two unclosed openers in sequence — first auto-closes", () => {
			const input = '<set path="a"><get path="b"/></set>';
			const { commands } = parse(input);
			assert.ok(commands.length >= 1);
			assert.strictEqual(commands[0].name, "set");
		});

		it("mismatched close (set then </get>) — recover", () => {
			const { commands } = parse('<set path="a">body</get>');
			// Either: capture set and warn, or drop. Don't crash.
			assert.ok(Array.isArray(commands));
		});
	});

	describe("G. Mixed and concurrent issues", () => {
		it("regex in fenced code inside set body (THE original failure)", () => {
			const input = `<set path="known://regex/ipv4" visibility="visible" summary="ipv4,strict" tokens="150">
# Related
[Task](prompt://1)

# PCRE-Compatible Strict IPv4 Regex (No Leading Zeros)
\`\`\`
(?<![a-zA-Z0-9])(?:0|[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-5])(?:\\.(?:0|[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-5])){3}(?![a-zA-Z0-9])
\`\`\`
Validates dotted decimal IPv4.
</set>
<set path="unknown://regex/ipv4" visibility="summarized" summary="RESOLVED"/>
<update status="156">written</update>`;
			const { commands, warnings } = parse(input);
			assert.strictEqual(
				commands.length,
				3,
				`got ${commands.length}: ${commands.map((c) => c.name).join(",")}`,
			);
			assert.strictEqual(commands[0].name, "set");
			assert.strictEqual(commands[1].name, "set");
			assert.strictEqual(commands[2].name, "update");
			assert.ok(commands[0].body?.includes("(?<![a-zA-Z0-9])"));
			assert.deepStrictEqual(
				warnings.filter((w) => /unclosed|missing/i.test(w)),
				[],
				"no spurious warnings on well-formed input with regex content",
			);
		});

		it("heredoc inside sh", () => {
			const input = "<sh>cat <<EOF\nline with < and >\nEOF</sh>";
			expectOne(input, "sh", (c) =>
				assert.ok(c.command?.includes("line with < and >")),
			);
		});

		it("multiple sets each with code content", () => {
			const input = [
				'<set path="a.py">x = [i for i in range(n) if i < 5]</set>',
				'<set path="b.rs">fn f<T>(x: T) -> T { x }</set>',
			].join("\n");
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(commands[0].name, "set");
			assert.strictEqual(commands[1].name, "set");
			assert.ok(commands[0].body?.includes("i < 5"));
			assert.ok(commands[1].body?.includes("fn f<T>(x: T)"));
		});

		it("trailing <update> after unclosed <set> is recovered as a sibling", () => {
			// Body opacity is the contract for *closed* bodies. When
			// `<set>` lacks its `</set>`, a clean trailing `<update>`
			// is the model's terminal signal trapped in the swallow —
			// recovery extracts it so the verdict layer sees the real
			// emission instead of reporting "no <update>" misleadingly.
			const input = '<set>broken<update status="200">recovered</update>';
			const { commands, warnings } = parse(input);
			assert.strictEqual(commands.length, 2);
			assert.strictEqual(commands[0].name, "set");
			assert.ok(commands[0].body?.includes("broken"));
			assert.strictEqual(commands[1].name, "update");
			assert.strictEqual(commands[1].status, 200);
			assert.ok(
				warnings.some((w) => w.includes("Unclosed") && w.includes("recovered")),
			);
		});
	});

	describe("H. Pre-processed model formats", () => {
		it("gemma fenced tool_code block", () => {
			const input = ["```tool_code", '<get path="a"/>', "```"].join("\n");
			expectOne(input, "get", (c) => assert.strictEqual(c.path, "a"));
		});

		it("openai function_call JSON", () => {
			const input = '{"name":"search","arguments":{"query":"foo"}}';
			expectOne(input, "search", (c) =>
				assert.ok(c.path === "foo" || c.body === "foo"),
			);
		});

		it("anthropic tool_use", () => {
			const input =
				'<tool_use><name>search</name><input>{"query":"foo"}</input></tool_use>';
			expectOne(input, "search");
		});

		it("mistral [TOOL_CALLS]", () => {
			const input = '[TOOL_CALLS] [{"name":"get","arguments":{"path":"a"}}]';
			expectOne(input, "get");
		});

		it("harmony channel pseudo-tags stripped", () => {
			const input = '<|channel:final|><get path="a"/><|im_end|>';
			expectOne(input, "get", (c) => assert.strictEqual(c.path, "a"));
		});

		it("qwen tool_call → translated", () => {
			const input = '<|tool_call>call:get{path: "a"}<tool_call|>';
			expectOne(input, "get");
		});
	});

	describe("I. Adversarial / weird shapes", () => {
		it("non-tool tag name treated as text", () => {
			const input = '<frobnicate path="x"/>'; // not in ALL_TOOLS
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 0);
		});

		it("tool name with trailing chars is NOT a tool", () => {
			const input = '<set2 path="x"/><get_x/>';
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 0);
		});

		it("plain '<' not followed by tag name", () => {
			const input = "if x < 5 then ok";
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 0);
		});

		it("'<' followed by space", () => {
			const input = '< get path="x"/>'; // space breaks tag-open
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 0);
		});

		it("uppercase tag name normalizes to lowercase tool", () => {
			const input = '<GET path="x"/>';
			const { commands } = parse(input);
			// Either accepted (lowercased) or rejected; both defensible. Don't crash.
			if (commands.length === 1) assert.strictEqual(commands[0].name, "get");
		});

		it("attribute value with literal close-tag string", () => {
			const input = '<set summary="ends with </set>" path="x">body</set>';
			// Outer set must close at the REAL </set> after "body", not at the false one in the summary.
			expectOne(input, "set", (c) => {
				assert.strictEqual(c.path, "x");
				assert.strictEqual(c.body, "body");
				assert.ok(c.summary?.includes("</set>"));
			});
		});

		it("body containing curly-quoted look-alike tag", () => {
			const input = '<set path="x">⟨set⟩ ⟨/set⟩ are not real tags</set>';
			expectOne(input, "set", (c) => assert.ok(c.body?.includes("⟨set⟩")));
		});

		it("repeated same attribute key — last wins or first wins consistently", () => {
			const input = '<get path="first" path="second"/>';
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 1);
			assert.ok(["first", "second"].includes(commands[0].path));
		});

		it("self-close with whitespace in slash", () => {
			const input = '<get path="x"  /  >';
			const { commands } = parse(input);
			// Either accepted as self-close or rejected as unclosed.
			if (commands.length === 1) assert.strictEqual(commands[0].path, "x");
		});

		it("unclosed quote then later tag", () => {
			const input =
				'<set path="oops>body</set><update status="200">ok</update>';
			const { commands } = parse(input);
			// At minimum, the trailing update must still be findable.
			assert.ok(commands.some((c) => c.name === "update"));
		});

		it("all whitespace input", () => {
			const { commands } = parse("   \n\n   \t\t  ");
			assert.strictEqual(commands.length, 0);
		});

		it("empty input", () => {
			const { commands } = parse("");
			assert.strictEqual(commands.length, 0);
		});

		it("null input", () => {
			const { commands } = parse(null);
			assert.strictEqual(commands.length, 0);
		});

		it("undefined input", () => {
			const { commands } = parse(undefined);
			assert.strictEqual(commands.length, 0);
		});
	});

	describe("J. Real-world failure samples (regression locks)", () => {
		it("regex-log turn 12 (lookbehind in fenced code)", () => {
			// Verbatim shape that broke us in pre-flight bjib0yng2.
			const input = `<get path="prompt://1"/>
<get path="known://regex/date"/>
<set path="known://regex/ipv4" visibility="visible" summary="regex,ipv4,pcre,strict,no-leading-zeros,octet-0-255,decimal,dotted,boundaries,alphanumeric" tokens="150">
# Related
[Task](prompt://1)

# PCRE-Compatible Strict IPv4 Regex (No Leading Zeros)
\`\`\`
(?<![a-zA-Z0-9])(?:0|[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-5])(?:\\.(?:0|[1-9]\\d?|1\\d\\d|2[0-4]\\d|25[0-5])){3}(?![a-zA-Z0-9])
\`\`\`
Validates dotted decimal IPv4: each octet 0-255.
</set>
<set path="unknown://regex/ipv4" visibility="summarized" summary="RESOLVED"/>
<update status="156">this unknown's known entries written</update>`;
			const { commands, warnings } = parse(input);
			const names = commands.map((c) => c.name);
			assert.deepStrictEqual(
				names,
				["get", "get", "set", "set", "update"],
				`expected get,get,set,set,update; got ${names.join(",")}`,
			);
			assert.deepStrictEqual(
				warnings.filter((w) => /unclosed|missing/i.test(w)),
				[],
				"must not warn on well-formed input with regex lookbehind",
			);
		});

		it("training-leak <|eos|> tokens interspersed with reasoning", () => {
			// Real grok-4.1-fast output: training tokens leak into reasoning_content
			// which then flows into next-turn assembly. Parser sees them as text.
			const input = [
				"thinking...<|eos|>more thinking",
				'<update status="200">done</update>',
			].join("\n");
			const { commands } = parse(input);
			assert.strictEqual(commands.length, 1);
			assert.strictEqual(commands[0].name, "update");
		});

		it("set with SEARCH/REPLACE marker pair routes to operations[0]", () => {
			const input = `<set path="src/x.js"><<:::SEARCH
old
:::SEARCH<<:::REPLACE
new
:::REPLACE</set>`;
			expectOne(input, "set", (c) => {
				assert.strictEqual(c.operations?.[0]?.op, "search_replace");
				assert.strictEqual(c.operations[0].search, "old");
				assert.strictEqual(c.operations[0].replace, "new");
			});
		});
	});
});
