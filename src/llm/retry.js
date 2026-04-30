// Time-bounded exponential backoff with full jitter; mid-sleep AbortSignal-aware.
export async function retryWithBackoff(
	fn,
	{
		signal,
		deadlineMs,
		baseDelayMs = 1000,
		maxDelayMs = 30_000,
		isRetryable,
		onRetry,
	} = {},
) {
	const startTime = Date.now();
	let attempt = 0;
	while (true) {
		signal?.throwIfAborted();
		try {
			return await fn();
		} catch (err) {
			if (!isRetryable(err)) throw err;
			const elapsedMs = Date.now() - startTime;
			const remainingMs = deadlineMs - elapsedMs;
			if (remainingMs <= 0) {
				throw new Error(
					`transient failures persisted ${Math.round(elapsedMs / 1000)}s past deadline; last error: ${err.message}`,
					{ cause: err },
				);
			}
			const expCap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
			const jittered = Math.floor(Math.random() * expCap);
			const delayMs = Math.min(remainingMs, jittered);
			onRetry?.(err, attempt + 1, delayMs, remainingMs);
			await sleep(delayMs, signal);
			attempt++;
		}
	}
}

// Per-category retry. Each category gets its own deadline budget; a
// category transition resets prior category state — the rationale being
// that seeing a different category proves upstream is alive in some way,
// so prior gateway/server storms aren't relevant to the new attempt.
// Honors err.retryAfter (seconds) as a delay floor for rate-limit hints.
export async function retryClassified(
	fn,
	{ signal, classify, policies, onRetry } = {},
) {
	const state = new Map(); // category → { start: ms, attempts: number }
	let lastCategory = null;

	while (true) {
		signal?.throwIfAborted();
		try {
			return await fn();
		} catch (err) {
			const category = classify(err);
			if (!category) throw err;
			const policy = policies[category];
			if (!policy) {
				throw new Error(
					`retryClassified: no policy for category "${category}"`,
					{ cause: err },
				);
			}

			if (lastCategory !== category) state.clear();
			if (!state.has(category)) {
				state.set(category, { start: Date.now(), attempts: 0 });
			}
			lastCategory = category;

			const s = state.get(category);
			const elapsedMs = Date.now() - s.start;
			const remainingMs = policy.deadlineMs - elapsedMs;
			if (remainingMs <= 0) {
				throw new Error(
					`${category} retry exhausted after ${Math.round(elapsedMs / 1000)}s; last error: ${err.message}`,
					{ cause: err },
				);
			}

			const expCap = Math.min(
				policy.maxDelayMs,
				policy.baseDelayMs * 2 ** s.attempts,
			);
			const jittered = Math.floor(Math.random() * expCap);
			const delayMs =
				err.retryAfter !== undefined
					? Math.min(remainingMs, Math.max(err.retryAfter * 1000, jittered))
					: Math.min(remainingMs, jittered);

			onRetry?.(err, category, s.attempts + 1, delayMs, remainingMs);
			await sleep(delayMs, signal);
			s.attempts++;
		}
	}
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (!signal) return;
		const onAbort = () => {
			clearTimeout(t);
			reject(signal.reason || new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
