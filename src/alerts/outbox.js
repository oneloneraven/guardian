import { postDiscord } from "./discord.js";

/**
 * @typedef {import("../lib/db.js").Database} Database
 * @typedef {import("./policy.js").Alert} Alert
 * @typedef {{ DB: Database, DISCORD_WEBHOOK_URL?: string }} OutboxEnv
 * @typedef {{ id: number, kind: Alert["kind"], target: string, subject: string, reason: string }} Row
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const CLAIM_EXPIRED = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')";

/**
 * @param {OutboxEnv} env
 * @param {Alert} alert
 * @returns {Promise<boolean>} false when an identical alert is already pending or standing
 */
export async function raise(env, { kind, target, subject, text }) {
  const duplicate =
    kind === "new-repository"
      ? await env.DB.prepare("SELECT 1 AS found FROM alerts WHERE target = ?1 LIMIT 1").bind(target).first()
      : await env.DB.prepare(
          `SELECT 1 AS found FROM alerts a
           WHERE a.kind = ?1 AND a.target = ?2 AND a.subject = ?3 AND a.reason = ?4
             AND (a.notified = 0 OR NOT EXISTS (
               SELECT 1 FROM alerts b WHERE b.target = a.target AND b.subject = a.subject AND b.id > a.id
             ))
           LIMIT 1`,
        )
          .bind(kind, target, subject, text)
          .first();
  if (duplicate) return false;
  await env.DB.prepare(`INSERT INTO alerts (kind, target, subject, reason, posted_at) VALUES (?1, ?2, ?3, ?4, ${NOW})`)
    .bind(kind, target, subject, text)
    .run();
  return true;
}

/** @param {OutboxEnv} env */
async function alertsOn(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'check-alerts'").first();
  return row?.value === JSON.stringify("on");
}

/**
 * @param {OutboxEnv} env
 * @param {Row} row
 */
async function stillHolds(env, row) {
  if (row.kind === "new-repository") {
    const repository = await env.DB.prepare("SELECT expected_visibility FROM repositories WHERE name = ?1")
      .bind(row.target)
      .first();
    return repository !== null && repository.expected_visibility === null;
  }
  if (row.kind === "cloudflare") return true;
  const result = await env.DB.prepare("SELECT status, reason FROM results WHERE target = ?1 AND check_id = ?2")
    .bind(row.target, row.subject)
    .first();
  if (!result) return false;
  switch (row.kind) {
    case "fail":
      return result.status === "fail" && result.reason != null && row.reason.includes(String(result.reason));
    case "resolved":
      return result.status === "pass" || result.status === "skipped";
    default:
      return result.status === "unknown";
  }
}

/**
 * @param {OutboxEnv} env
 * @param {number[]} ids
 * @param {boolean} notified
 */
async function settle(env, ids, notified) {
  if (ids.length === 0) return;
  const sql = notified
    ? "UPDATE alerts SET notified = 1, claimed_at = NULL WHERE id = ?1"
    : "UPDATE alerts SET claimed_at = NULL WHERE id = ?1";
  await env.DB.batch(ids.map(id => env.DB.prepare(sql).bind(id)));
}

/**
 * Posts each pending alert whose result is still in the state it describes, and drops the rest unposted.
 * @param {OutboxEnv} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<number>}
 */
export async function deliverPending(env, fetchImpl) {
  if (!(await alertsOn(env))) return 0;
  const { results } = await env.DB.prepare(
    `UPDATE alerts SET claimed_at = ${NOW}
     WHERE notified = 0 AND (claimed_at IS NULL OR claimed_at < ${CLAIM_EXPIRED})
     RETURNING id, kind, target, subject, reason`,
  ).all();
  const rows = /** @type {Row[]} */ (/** @type {unknown} */ (results)).sort((a, b) => a.id - b.id);
  /** @type {Set<string>} */
  const unannounced = new Set();
  let posted = 0;
  for (const row of rows) {
    const key = `${row.target}\u0000${row.subject}`;
    const holds = await stillHolds(env, row);
    if (row.kind === "resolved" && unannounced.delete(key)) {
      await settle(env, [row.id], true);
    } else if (!holds) {
      if (row.kind === "fail") unannounced.add(key);
      await settle(env, [row.id], true);
    } else if (await postDiscord(env, row.reason, fetchImpl)) {
      await settle(env, [row.id], true);
      posted++;
    } else {
      await settle(
        env,
        rows.slice(rows.indexOf(row)).map(pending => pending.id),
        false,
      );
      return posted;
    }
  }
  return posted;
}

const RETENTION_DAYS = 90;

/**
 * @param {OutboxEnv} env
 * @param {Date | string | number} now
 * @returns {Promise<number>}
 */
export async function pruneAlerts(env, now) {
  const cutoff = new Date(new Date(now).getTime() - RETENTION_DAYS * 86_400_000).toISOString();
  const { meta } = await env.DB.prepare("DELETE FROM alerts WHERE notified = 1 AND posted_at < ?1").bind(cutoff).run();
  return meta.changes;
}
