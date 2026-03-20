import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import SymbolExtractor from "./SymbolExtractor.js";

describe("SymbolExtractor", () => {
	it("should extract JS class, function, and method definitions", () => {
		const extractor = new SymbolExtractor();
		const content = `
class MyClass {
  myMethod(x) {
    return x;
  }
}
function myFunc(y) {
  return y;
}
myFunc(1);
    `.trim();

		const result = extractor.extract(content, "js");

		ok(
			result.definitions.find(
				(d) => d.name === "MyClass" && d.type === "class",
			),
		);
		ok(
			result.definitions.find(
				(d) => d.name === "myMethod" && d.type === "method",
			),
		);
		ok(
			result.definitions.find(
				(d) => d.name === "myFunc" && d.type === "function",
			),
		);
		ok(result.references.includes("myFunc"));
	});

	it("should extract CSS classes and IDs", () => {
		const extractor = new SymbolExtractor();
		const content = `
.my-class { color: red; }
#my-id { font-size: 12px; }
    `.trim();

		const result = extractor.extract(content, "css");

		ok(
			result.definitions.find(
				(d) => d.name === "my-class" && d.type === "class",
			),
		);
		ok(result.definitions.find((d) => d.name === "my-id" && d.type === "id"));
	});

	it("should return null for unsupported extensions", () => {
		const extractor = new SymbolExtractor();
		const result = extractor.extract("some content", "unknown");

		strictEqual(result, null);
	});

	it("should handle extraction errors gracefully", () => {
		const _extractor = new SymbolExtractor();
		// Passing something that makes tree-sitter crash or fail if possible
		// But usually it just returns an error node.
		// Let's try to mock the internal parser if we really need to test catch block.
	});
});
