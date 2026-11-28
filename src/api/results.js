import { listResults, loadTitles } from "../results/read.js";

/** @typedef {Parameters<typeof loadTitles>[0]} ResultsEnv */

const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const HEADERS = { "Cache-Control": "no-store" };

/** @param {number} status @param {unknown} body @param {Record<string, string>} [extra] */
const reply = (status, body, extra = {}) => Response.json(body, { status, headers: { ...HEADERS, ...extra } });

/** @param {string} segment */
function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * @param {Request} request
 * @param {ResultsEnv} env
 * @returns {Promise<Response>}
 */
export async function routeResults(request, env) {
  const { pathname } = new URL(request.url);
  const match = /^\/v1\/results(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return reply(404, { error: "Not found" });
  if (request.method !== "GET") return reply(405, { error: "Method not allowed" }, { Allow: "GET" });
  const { titles, version } = await loadTitles(env);
  if (match[1] === undefined) {
    return reply(200, { standard: version ? { version } : null, results: await listResults(env, titles) });
  }
  const repository = decode(match[1]);
  if (repository === null || !REPOSITORY_NAME.test(repository)) return reply(404, { error: "Not found" });
  const results = await listResults(env, titles, repository);
  const known =
    results.length > 0 || (await env.DB.prepare("SELECT 1 FROM repositories WHERE name = ?1").bind(repository).first());
  if (!known) return reply(404, { error: "Not found" });
  const { results: events } = await env.DB.prepare(
    "SELECT action, actor, detail, occurred_at AS at FROM security_events WHERE target = ?1 ORDER BY occurred_at DESC, id DESC LIMIT 10",
  )
    .bind(repository)
    .all();
  return reply(200, { repository, results, events });
}
