/**
 * Exponential backoff with full jitter, time-bounded.
 *
 * Calls `fn` until it returns a value, the deadline elapses, or a
 * non-retryable error is thrown. Between attempts, sleeps for a
 * random duration in [0, min(maxDelayMs, baseDelayMs * 2^attempt)).
 * Full jitter (AWS / Google Cloud pattern) prevents thundering-herd
 * synchronization across concurrent clients hitting the same API.
 *
 * Time-bounded, not count-bounded: a connect-level outage that
 * recovers in 4 minutes is invisible to the caller, but a persistent
 * outage fails after deadlineMs with a clear cause chain.
 *
 * Aborts immediately if the supplied AbortSignal fires — even mid-sleep.
 */
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
