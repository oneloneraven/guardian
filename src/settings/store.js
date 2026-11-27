import { postDiscord } from "../alerts/discord.js";

/** @typedef {import("../lib/db.js").Database} Database */
/** @typedef {{ DB: Database, OWNER_EMAIL?: string, DISCORD_WEBHOOK_URL?: string, ADMIN_HOST?: string }} SettingsEnv */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// A post that crashes mid-flight leaves its claim behind; after this long another run may take it over.
const CLAIM_EXPIRED = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')";

/**
 * @param {{ OWNER_EMAIL?: string }} env
 * @param {string | null | undefined} email
 * @returns {"the owner" | "another Access user"}
 */
export function describeActor(env, email) {
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  return owner && (email ?? "").trim().toLowerCase() === owner ? "the owner" : "another Access user";
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
const serialise = value => (value == null ? null : JSON.stringify(value));

/**
 * @param {SettingsEnv} env
 * @param {number[]} ids
 * @param {boolean} posted
 */
async function settle(env, ids, posted) {
  if (ids.length === 0) return;
  const sql = posted
    ? "UPDATE settings_audit SET notified = 1, claimed_at = NULL WHERE id = ?1"
    : "UPDATE settings_audit SET claimed_at = NULL WHERE id = ?1";
  try {
    await env.DB.batch(ids.map(id => env.DB.prepare(sql).bind(id)));
  } catch (error) {
    console.error("Settings audit update failed", error instanceof Error ? error.message : error);
  }
}

/**
 * @param {SettingsEnv} env
 * @param {{ email: string, key: string, from: unknown, to: unknown, apply: (db: Database) => import("../lib/db.js").Statement[] }} change
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ notified: boolean }>}
 */
export async function changeSetting(env, { email, key, from, to, apply }, fetchImpl) {
  const actor = describeActor(env, email);
  const statements = apply(env.DB);
  const results = await env.DB.batch([
    ...statements,
    env.DB.prepare(
      `INSERT INTO settings_audit (actor, key, from_value, to_value, claimed_at) VALUES (?1, ?2, ?3, ?4, ${NOW}) RETURNING id`,
    ).bind(actor, key, serialise(from), serialise(to)),
  ]);
  const [audit] = results[results.length - 1].results;
  const notified = await postDiscord(env, announcement(env, actor, key), fetchImpl);
  await settle(env, [/** @type {number} */ (audit.id)], notified);
  return { notified };
}

/**
 * @param {SettingsEnv} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<number>}
 */
export async function retryUnnotified(env, fetchImpl) {
  const { results } = await env.DB.prepare(
    `UPDATE settings_audit SET claimed_at = ${NOW}
     WHERE notified = 0 AND (claimed_at IS NULL OR claimed_at < ${CLAIM_EXPIRED})
     RETURNING id, actor, key`,
  ).all();
  const rows = /** @type {{ id: number, actor: string, key: string }[]} */ (results).sort((a, b) => a.id - b.id);
  let posted = 0;
  for (const row of rows) {
    if (!(await postDiscord(env, announcement(env, row.actor, row.key), fetchImpl))) break;
    await settle(env, [row.id], true);
    posted++;
  }
  await settle(
    env,
    rows.slice(posted).map(row => row.id),
    false,
  );
  return posted;
}
