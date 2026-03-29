import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import createHooks from "../../domain/hooks/Hooks.js";
import StateEvaluator from "./StateEvaluator.js";

const mockTurnJson = (overrides = {}) => ({
	assistant: { unknown: [], known: [], summary: "", content: "", ...overrides },
});

const mockDb = (unresolvedFindings = []) => ({
	get_unresolved_findings: { all: async () => unresolvedFindings },
	insert_turn_element: { run: async () => {} },
});

const baseArgs = (overrides = {}) => ({
	flags: { hasAct: false, newReads: 0 },
	tools: [],
	turnJson: mockTurnJson(),
	finalResponse: { content: "" },
	runId: "r1",
	turnId: "t1",
	elements: [],
	inconsistencyRetries: 0,
	maxInconsistencyRetries: 3,
	parsedTodo: [],
	...overrides,
});

describe("StateEvaluator", () => {
	it("should return completed when summary present and no findings", async () => {
		const hooks = createHooks();
		const evaluator = new StateEvaluator(mockDb(), hooks);
		const result = await evaluator.evaluate(
			baseArgs({ flags: { hasAct: false, newReads: 0 } }),
		);
		strictEqual(result.action, "completed");
	});

	it("should return proposed when unresolved findings exist", async () => {
		const hooks = createHooks();
		const evaluator = new StateEvaluator(
			mockDb([{ category: "diff", id: 1 }]),
			hooks,
		);
		const result = await evaluator.evaluate(baseArgs());
		strictEqual(result.action, "proposed");
	});

	it("should return continue when hasAct is true", async () => {
		const hooks = createHooks();
		const evaluator = new StateEvaluator(mockDb(), hooks);
		const result = await evaluator.evaluate(
			baseArgs({ flags: { hasAct: true, newReads: 0 } }),
		);
		strictEqual(result.action, "continue");
	});

	it("should return continue when newReads > 0", async () => {
		const hooks = createHooks();
		const evaluator = new StateEvaluator(mockDb(), hooks);
		const result = await evaluator.evaluate(
			baseArgs({ flags: { hasAct: false, newReads: 2 } }),
		);
		strictEqual(result.action, "continue");
	});

	it("should return retry on warnings with retries remaining", async () => {
		const hooks = createHooks();
		const evaluator = new StateEvaluator(mockDb(), hooks);
		const result = await evaluator.evaluate(
			baseArgs({
				flags: { hasAct: false, newReads: 0 },
				turnJson: mockTurnJson({ unknown: ["something unclear"] }),
				tools: [],
			}),
		);
		strictEqual(result.action, "retry");
		strictEqual(result.warnings.length > 0, true);
	});

	it("should return completed as fallback", async () => {
		const hooks = createHooks();
		const evaluator = new StateEvaluator(mockDb(), hooks);
		const result = await evaluator.evaluate(baseArgs());
		strictEqual(result.action, "completed");
	});

	it("should inject warnings into context when context node present", async () => {
		const hooks = createHooks();
		const evaluator = new StateEvaluator(mockDb(), hooks);
		const ctxNode = { tag_name: "context", id: 99 };
		const result = await evaluator.evaluate(
			baseArgs({
				flags: { hasAct: false, newReads: 0 },
				turnJson: mockTurnJson({ unknown: ["question"] }),
				elements: [ctxNode],
			}),
		);
		ok(result.warnings.length > 0);
	});

	it("should not retry when retries exhausted", async () => {
		const hooks = createHooks();
		const evaluator = new StateEvaluator(mockDb(), hooks);
		const result = await evaluator.evaluate(
			baseArgs({
				flags: { hasAct: false, newReads: 0 },
				turnJson: mockTurnJson({ unknown: ["question"] }),
				inconsistencyRetries: 3,
				maxInconsistencyRetries: 3,
			}),
		);
		// Warnings present but retries exhausted — falls through to completed
		strictEqual(result.action, "completed");
	});

	it("proposed takes priority over hasAct", async () => {
		const hooks = createHooks();
		const evaluator = new StateEvaluator(
			mockDb([{ category: "diff", id: 1 }]),
			hooks,
		);
		const result = await evaluator.evaluate(
			baseArgs({ flags: { hasAct: true, newReads: 0 } }),
		);
		strictEqual(result.action, "proposed");
	});
});
