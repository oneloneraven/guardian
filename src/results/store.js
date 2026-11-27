/**
 * @typedef {import("../lib/db.js").Database} Database
 * @typedef {import("../checks/result.js").Result} Result
 * @typedef {{
 *   target: string,
 *   check: string,
 *   previous: Result["status"] | null,
 *   status: Result["status"],
 *   reason: string,
 *   reasonChanged: boolean,
 *   unknownSweeps: number,
 * }} Transition
 */

const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * @param {{ DB: Database }} env
 * @param {{ target: string, check: string, result: Result, by: "event" | "sweep" | "daily", at: string }} input
 * @returns {Promise<Transition>}
 */
export async function saveResult(env, { target, check, result, by, at }) {
  const old = await env.DB.prepare(
    "SELECT status, reason, unknown_sweeps AS unknownSweeps FROM results WHERE target = ?1 AND check_id = ?2",
  )
    .bind(target, check)
    .first();
  const previous = /** @type {Result["status"] | null} */ (old ? /** @type {any} */ (old.status) : null);
  const changed = previous !== result.status;
  const unknownSweeps =
    result.status !== "unknown"
      ? 0
      : by === "event"
        ? Number(old?.unknownSweeps ?? 0)
        : Number(old?.unknownSweeps ?? 0) + 1;
  await env.DB.prepare(
    `INSERT INTO results (target, check_id, status, reason, link, previous_status, checked_at, changed_at, changed_by, unknown_sweeps)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9)
     ON CONFLICT (target, check_id) DO UPDATE SET
       status = excluded.status,
       reason = excluded.reason,
       link = excluded.link,
       previous_status = excluded.previous_status,
       checked_at = excluded.checked_at,
       changed_at = CASE WHEN results.status = excluded.status THEN results.changed_at ELSE excluded.changed_at END,
       changed_by = CASE WHEN results.status = excluded.status THEN results.changed_by ELSE excluded.changed_by END,
       unknown_sweeps = excluded.unknown_sweeps`,
  )
    .bind(target, check, result.status, result.reason, result.link, previous, at, by, unknownSweeps)
    .run();
  return {
    target,
    check,
    previous,
    status: result.status,
    reason: result.reason,
    reasonChanged: !changed && old !== null && old.reason !== result.reason,
    unknownSweeps,
  };
}

/**
 * @param {{ DB: Database }} env
 * @param {{ delivery: string | null, source: "github", target: string, action: string, actor: string | null, detail: string | null, at: string }} event
 * @returns {Promise<boolean>} false when the delivery was already stored
 */
export async function recordEvent(env, { delivery, source, target, action, actor, detail, at }) {
  const { meta } = await env.DB.prepare(
    `INSERT OR IGNORE INTO security_events (source, target, action, actor, detail, occurred_at, delivery)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(source, target, action, actor, detail, at, delivery)
    .run();
  return meta.changes > 0;
}

/**
 * @param {{ DB: Database }} env
 * @param {Date | string | number} now
 * @returns {Promise<number>}
 */
export async function pruneEvents(env, now) {
  const cutoff = new Date(new Date(now).getTime() - RETENTION_DAYS * DAY_MS).toISOString();
  const { meta } = await env.DB.prepare("DELETE FROM security_events WHERE occurred_at < ?1").bind(cutoff).run();
  return meta.changes;
}
