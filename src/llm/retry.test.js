import assert from "node:assert";
import { describe, it } from "node:test";
import { retryClassified, retryWithBackoff } from "./retry.js";

describe("retryWithBackoff", () => {
	it("returns immediately on success without sleeping", async () => {
		const start = Date.now();
		const result = await retryWithBackoff(() => Promise.resolve("ok"), {
			deadlineMs: 10_000,
			isRetryable: () => true,
		});
		assert.strictEqual(result, "ok");
		assert.ok(Date.now() - start < 50, "no sleep on first-try success");
	});

	it("retries until success when error is retryable", async () => {
		let attempts = 0;
		const result = await retryWithBackoff(
			() => {
				attempts++;
				if (attempts < 3) throw new Error("503 Service Unavailable");
				return Promise.resolve("done");
			},
			{
				deadlineMs: 10_000,
				baseDelayMs: 1,
				maxDelayMs: 5,
				isRetryable: () => true,
			},
		);
		assert.strictEqual(result, "done");
		assert.strictEqual(attempts, 3);
	});

	it("rethrows immediately when error is not retryable", async () => {
		let attempts = 0;
		await assert.rejects(
			retryWithBackoff(
				() => {
					attempts++;
					throw new Error("401 Unauthorized");
				},
				{
					deadlineMs: 10_000,
					isRetryable: (err) => err.message.includes("503"),
				},
			),
			/401/,
		);
		assert.strictEqual(attempts, 1, "no retries on non-retryable");
	});

	it("throws deadline-exceeded when retries persist past deadline", async () => {
		await assert.rejects(
			retryWithBackoff(() => Promise.reject(new Error("ECONNRESET")), {
				deadlineMs: 50,
				baseDelayMs: 5,
				maxDelayMs: 10,
				isRetryable: () => true,
			}),
			/persisted .* past deadline.*ECONNRESET/,
		);
	});

	it("calls onRetry with attempt number, delay, and remaining time", async () => {
		const calls = [];
		let attempts = 0;
		await retryWithBackoff(
			() => {
				attempts++;
				if (attempts < 2) throw new Error("ETIMEDOUT");
				return "ok";
			},
			{
				deadlineMs: 10_000,
				baseDelayMs: 1,
				maxDelayMs: 5,
				isRetryable: () => true,
				onRetry: (err, attempt, delayMs, remainingMs) => {
					calls.push({ msg: err.message, attempt, delayMs, remainingMs });
				},
			},
		);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].attempt, 1);
		assert.strictEqual(calls[0].msg, "ETIMEDOUT");
		assert.ok(calls[0].delayMs >= 0);
		assert.ok(calls[0].remainingMs > 0);
	});

	it("aborts immediately when signal is already aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await assert.rejects(
			retryWithBackoff(() => Promise.resolve("never"), {
				signal: ctrl.signal,
				deadlineMs: 10_000,
				isRetryable: () => true,
			}),
		);
	});

	it("aborts mid-sleep when signal fires during backoff", async () => {
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(new Error("user cancel")), 10);
		await assert.rejects(
			retryWithBackoff(() => Promise.reject(new Error("503")), {
				signal: ctrl.signal,
				deadlineMs: 10_000,
				baseDelayMs: 100,
				maxDelayMs: 500,
				isRetryable: () => true,
			}),
			/cancel|aborted/i,
		);
	});

	it("delay never exceeds maxDelayMs even at high attempt counts", async () => {
		const observedDelays = [];
		let _attempts = 0;
		try {
			await retryWithBackoff(
				() => {
					_attempts++;
					throw new Error("503");
				},
				{
					deadlineMs: 200,
					baseDelayMs: 1000,
					maxDelayMs: 10,
					isRetryable: () => true,
					onRetry: (_err, _attempt, delayMs) => observedDelays.push(delayMs),
				},
			);
		} catch {}
		assert.ok(observedDelays.length > 0, "got at least one retry");
		for (const d of observedDelays) {
			assert.ok(d <= 10, `delay ${d} exceeded cap of 10`);
		}
	});
});

describe("retryClassified", () => {
	const policies = {
		gateway: { deadlineMs: 50, baseDelayMs: 1, maxDelayMs: 5 },
		warmup: { deadlineMs: 500, baseDelayMs: 1, maxDelayMs: 5 },
		server: { deadlineMs: 100, baseDelayMs: 1, maxDelayMs: 5 },
	};

	it("returns immediately on first-try success", async () => {
		const start = Date.now();
		const result = await retryClassified(() => Promise.resolve("ok"), {
			classify: () => "gateway",
			policies,
		});
		assert.strictEqual(result, "ok");
		assert.ok(Date.now() - start < 50);
	});

	it("propagates non-retryable when classify returns null", async () => {
		let attempts = 0;
		await assert.rejects(
			retryClassified(
				() => {
					attempts++;
					throw new Error("401 Unauthorized");
				},
				{ classify: () => null, policies },
			),
			/401/,
		);
		assert.strictEqual(attempts, 1);
	});

	it("respects per-category deadline (gateway exhausts at its budget, not LLM_DEADLINE)", async () => {
		const start = Date.now();
		await assert.rejects(
			retryClassified(() => Promise.reject(new Error("502 Bad Gateway")), {
				classify: () => "gateway",
				policies,
			}),
			/gateway retry exhausted/,
		);
		const elapsed = Date.now() - start;
		// gateway deadline is 50ms; should fail well before warmup's 500ms.
		assert.ok(
			elapsed < 200,
			`expected <200ms (gateway budget), got ${elapsed}ms`,
		);
	});

	it("category transition resets prior category state", async () => {
		// Sequence: gateway, gateway (within budget), warmup (resets), gateway (fresh budget), success.
		// Without the reset, two distinct gateway sequences would risk overflowing the 50ms budget.
		const sequence = ["gateway", "gateway", "warmup", "gateway", "ok"];
		let i = 0;
		const result = await retryClassified(
			() => {
				const next = sequence[i++];
				if (next === "ok") return Promise.resolve("done");
				return Promise.reject(new Error(next));
			},
			{
				classify: (err) => err.message,
				policies,
			},
		);
		assert.strictEqual(result, "done");
		assert.strictEqual(i, 5, "all sequence steps consumed");
	});

	it("honors err.retryAfter as delay floor", async () => {
		const observedDelays = [];
		let attempts = 0;
		await retryClassified(
			() => {
				attempts++;
				if (attempts < 2) {
					const err = new Error("429");
					err.retryAfter = 0.01; // 10ms floor
					throw err;
				}
				return Promise.resolve("ok");
			},
			{
				classify: () => "warmup",
				// baseDelayMs/maxDelayMs both 0 → jittered delay is 0; floor must win.
				policies: {
					warmup: { deadlineMs: 1000, baseDelayMs: 0, maxDelayMs: 0 },
				},
				onRetry: (_err, _cat, _attempt, delayMs) =>
					observedDelays.push(delayMs),
			},
		);
		assert.ok(
			observedDelays[0] >= 10,
			`expected ≥10ms (retry-after floor), got ${observedDelays[0]}`,
		);
	});

	it("aborts immediately when signal is already aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await assert.rejects(
			retryClassified(() => Promise.resolve("never"), {
				signal: ctrl.signal,
				classify: () => "gateway",
				policies,
			}),
		);
	});

	it("aborts mid-sleep when signal fires during backoff", async () => {
		const ctrl = new AbortController();
		setTimeout(() => ctrl.abort(new Error("user cancel")), 10);
		await assert.rejects(
			retryClassified(() => Promise.reject(new Error("502")), {
				signal: ctrl.signal,
				classify: () => "gateway",
				policies: {
					gateway: { deadlineMs: 10_000, baseDelayMs: 100, maxDelayMs: 500 },
				},
			}),
			/cancel|aborted/i,
		);
	});

	it("throws when classifier returns a category with no policy", async () => {
		await assert.rejects(
			retryClassified(() => Promise.reject(new Error("502")), {
				classify: () => "unknown_category",
				policies,
			}),
			/no policy for category "unknown_category"/,
		);
	});

	it("calls onRetry with category in third-arg position", async () => {
		const calls = [];
		let attempts = 0;
		await retryClassified(
			() => {
				attempts++;
				if (attempts < 2) throw new Error("502");
				return Promise.resolve("ok");
			},
			{
				classify: () => "gateway",
				policies,
				onRetry: (err, category, attempt, delayMs, remainingMs) => {
					calls.push({
						msg: err.message,
						category,
						attempt,
						delayMs,
						remainingMs,
					});
				},
			},
		);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].category, "gateway");
		assert.strictEqual(calls[0].attempt, 1);
	});
});
