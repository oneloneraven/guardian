import { postDiscord } from "../alerts/discord.js";

/** @typedef {{ DB: import("../lib/db.js").Database, OWNER_EMAIL?: string, DISCORD_WEBHOOK_URL?: string, ADMIN_HOST?: string }} SettingsEnv */

/**
 * @param {{ OWNER_EMAIL?: string }} env
 * @param {string} email
 * @returns {string}
 */
export function describeActor(env, email) {
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  return owner && email.trim().toLowerCase() === owner ? "the owner" : "another Access user";
}

/**
 * @param {SettingsEnv} env
 * @param {string} actor
 * @param {string} key
 */
function announcement(env, actor, key) {
  const text = `Guardian settings: ${actor} changed ${key}`;
  return env.ADMIN_HOST ? `${text}: https://${env.ADMIN_HOST}/` : text;
}

/** @param {unknown} value */
const serialise = value => (value === undefined ? null : JSON.stringify(value));

/**
 * @param {SettingsEnv} env
 * @param {{ actor: string, key: string, from: unknown, to: unknown, apply: (db: import("../lib/db.js").Database) => import("../lib/db.js").Statement[] }} change
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ notified: boolean }>}
 */
export async function changeSetting(env, { actor, key, from, to, apply }, fetchImpl) {
  const statements = apply(env.DB);
  const results = await env.DB.batch([
    ...statements,
    env.DB.prepare(
      "INSERT INTO settings_audit (actor, key, from_value, to_value) VALUES (?1, ?2, ?3, ?4) RETURNING id",
    ).bind(actor, key, serialise(from), serialise(to)),
  ]);
  const [audit] = results[results.length - 1].results;
  const id = /** @type {number} */ (audit.id);
  const notified = await postDiscord(env, announcement(env, actor, key), fetchImpl);
  if (notified) await env.DB.prepare("UPDATE settings_audit SET notified = 1 WHERE id = ?1").bind(id).run();
  return { notified };
}

/**
 * @param {SettingsEnv} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<number>}
 */
export async function retryUnnotified(env, fetchImpl) {
  const { results } = await env.DB.prepare(
    "SELECT id, actor, key FROM settings_audit WHERE notified = 0 ORDER BY id",
  ).all();
  let posted = 0;
  for (const row of /** @type {{ id: number, actor: string, key: string }[]} */ (results)) {
    if (!(await postDiscord(env, announcement(env, row.actor, row.key), fetchImpl))) break;
    await env.DB.prepare("UPDATE settings_audit SET notified = 1 WHERE id = ?1").bind(row.id).run();
    posted++;
  }
  return posted;
}
