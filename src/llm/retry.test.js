import assert from "node:assert";
import { describe, it } from "node:test";
import { retryWithBackoff } from "./retry.js";

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
