/**
 * Bounded async test coordination.
 *
 * WebCrypto completion is scheduled outside the JavaScript microtask queue.
 * A tight setImmediate loop can therefore exhaust its turn budget while the
 * HMAC worker is still queued, especially when the full test suite is running
 * in parallel. Poll with a timer and a monotonic deadline instead.
 */
export async function settleEventLoop(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function waitForCondition(predicate, { timeoutMilliseconds = 1_000, pollMilliseconds = 1 } = {}) {
  const timeout = Math.max(1, Math.trunc(timeoutMilliseconds));
  const poll = Math.max(1, Math.trunc(pollMilliseconds));
  const deadline = performance.now() + timeout;
  while (true) {
    if (predicate()) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return predicate();
    await new Promise((resolve) => setTimeout(resolve, Math.min(poll, Math.ceil(remaining))));
  }
}
