const TIMEOUT_MS = 10_000;

/**
 * @param {{ BETTER_STACK_HEARTBEAT_URL?: string }} env
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function pingHeartbeat(env, fetchImpl = fetch, timeoutMs = TIMEOUT_MS) {
  if (!env.BETTER_STACK_HEARTBEAT_URL) return false;
  try {
    const response = await fetchImpl(env.BETTER_STACK_HEARTBEAT_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}
