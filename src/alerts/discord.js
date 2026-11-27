/**
 * @param {{ DISCORD_WEBHOOK_URL?: string }} env
 * @param {string} text
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function postDiscord(env, text, fetchImpl = fetch) {
  if (!env.DISCORD_WEBHOOK_URL) return false;
  try {
    const response = await fetchImpl(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
    });
    return response.ok;
  } catch (error) {
    console.error("Discord post failed", error instanceof Error ? error.message : error);
    return false;
  }
}
