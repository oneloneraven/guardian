import { loadStandard } from "../standard/pin.js";

/**
 * @typedef {{ DB: import("../lib/db.js").Database }} ReadEnv
 * @typedef {{ target: string, check: string, title: string, status: string, reason: string, link: string | null, checkedAt: string }} ResultView
 */

/**
 * @param {ReadEnv & Parameters<typeof loadStandard>[0]} env
 * @returns {Promise<{ titles: Map<string, string>, version: string | null }>}
 */
export async function loadTitles(env) {
  const loaded = await loadStandard(env);
  /** @type {Map<string, string>} */
  const titles = new Map([
    ["record-accepted", "Accepted record"],
    ["audit-log", "Cloudflare audit log"],
  ]);
  if ("standard" in loaded) {
    for (const check of /** @type {{ id: string, title?: string }[]} */ (loaded.standard.checks ?? [])) {
      if (check.title && !titles.has(check.id)) titles.set(check.id, check.title);
    }
  }
  return { titles, version: "standard" in loaded ? loaded.version : null };
}

/**
 * @param {ReadEnv} env
 * @param {Map<string, string>} titles
 * @param {string} [target]
 * @returns {Promise<ResultView[]>}
 */
export async function listResults(env, titles, target) {
  const { results } = await env.DB.prepare(
    `SELECT target, check_id AS "check", status, reason, link, checked_at AS checkedAt FROM results
     WHERE ?1 IS NULL OR target = ?1
     ORDER BY CASE status WHEN 'fail' THEN 0 WHEN 'unknown' THEN 1 WHEN 'skipped' THEN 2 ELSE 3 END, target, check_id`,
  )
    .bind(target ?? null)
    .all();
  return results.map(row => ({
    target: String(row.target),
    check: String(row.check),
    title: titles.get(String(row.check)) ?? String(row.check),
    status: String(row.status),
    reason: String(row.reason),
    link: row.link === null ? null : String(row.link),
    checkedAt: String(row.checkedAt),
  }));
}
