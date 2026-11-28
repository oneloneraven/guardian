import { recordEvent } from "../results/store.js";

/**
 * @typedef {{
 *   id: string,
 *   time: string,
 *   actorType: string,
 *   actorContext: string,
 *   tokenId: string,
 *   tokenName: string,
 *   actionType: string,
 *   actionResult: string,
 *   description: string,
 *   product: string,
 *   resourceType: string,
 *   resourceId: string,
 *   resourceScope: string,
 * }} AuditEntry
 * @typedef {{ DB: import("../lib/db.js").Database, CLOUDFLARE_ACCOUNT_ID?: string, CLOUDFLARE_AUDIT_TOKEN?: string }} AuditEnv
 */

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;
const MAX_PAGES = 20;
const PAGE_SIZE = 1000;
const OVERLAP_MS = 10 * 60_000;
const FIRST_RUN_MS = 15 * 60_000;
const CURSOR = "cloudflare-audit";

/** @param {unknown} value */
const clean = value =>
  String(value ?? "")
    .replaceAll("@", " ")
    .replaceAll("`", "'");

/** @param {any} raw @returns {AuditEntry} */
function toEntry(raw) {
  return {
    id: clean(raw.id),
    time: clean(raw.action?.time),
    actorType: clean(raw.actor?.type),
    actorContext: clean(raw.actor?.context),
    tokenId: clean(raw.actor?.token_id),
    tokenName: clean(raw.actor?.token_name),
    actionType: clean(raw.action?.type),
    actionResult: clean(raw.action?.result),
    description: clean(raw.action?.description),
    product: clean(raw.resource?.product),
    resourceType: clean(raw.resource?.type),
    resourceId: clean(raw.resource?.id),
    resourceScope: clean(raw.resource?.scope),
  };
}

/** @param {string} reason */
const unreadable = reason => ({ unreadable: reason });

/** @param {number} status */
const failure = status =>
  unreadable(
    status === 403
      ? "Can't read the audit log: the token needs Audit Logs Read"
      : `Couldn't read the audit log (HTTP ${status})`,
  );

/**
 * @param {AuditEnv} env
 * @param {Date | string | number} now
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ entries: AuditEntry[] } | { unreadable: string }>}
 */
export async function readAudit(env, now, fetchImpl = fetch) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_AUDIT_TOKEN) {
    return unreadable("Guardian has no Cloudflare audit token");
  }
  const end = new Date(now).getTime();
  const row = await env.DB.prepare("SELECT position FROM cursors WHERE name = ?1").bind(CURSOR).first();
  const mark = row ? new Date(String(row.position)).getTime() : Number.NaN;
  const start = Number.isNaN(mark) ? end - FIRST_RUN_MS : mark - OVERLAP_MS;
  const base = new URLSearchParams({
    since: new Date(start).toISOString(),
    before: new Date(end).toISOString(),
    direction: "asc",
    limit: String(PAGE_SIZE),
    "action_type[not]": "view",
  });
  const url = `${API}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/logs/audit`;

  /** @type {AuditEntry[]} */
  const entries = [];
  /** @type {string} */
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams(base);
    if (cursor) query.set("cursor", cursor);
    let response;
    try {
      response = await fetchImpl(`${url}?${query}`, {
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_AUDIT_TOKEN}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return failure(0);
    }
    if (!response.ok) return failure(response.status);
    /** @type {any} */
    let body;
    try {
      body = await response.json();
    } catch {
      return failure(response.status);
    }
    if (body?.success === false || !Array.isArray(body?.result)) return failure(response.status);
    for (const raw of body.result) {
      const entry = toEntry(raw);
      if (entry.actionType !== "view") entries.push(entry);
    }
    cursor = String(body.result_info?.cursor ?? "");
    if (!cursor) return { entries };
  }
  return unreadable(`Couldn't read the audit log (more than ${MAX_PAGES} pages)`);
}

/** @param {AuditEntry} entry */
function actorOf(entry) {
  if (entry.tokenName) return entry.tokenName;
  if (entry.actorType === "user") return "a dashboard user";
  if (entry.actorType === "system" || entry.actorType === "cloudflare_admin") return "Cloudflare";
  if (entry.actorType === "account" || entry.tokenId) return "an account token";
  return "an unknown actor";
}

/** @param {AuditEntry} entry @param {string} actor */
const detailOf = (entry, actor) =>
  `\`${actor}\`: ${entry.description || entry.actionType} (${entry.product} ${entry.resourceType})`;

/**
 * @param {AuditEnv} env
 * @param {AuditEntry[]} entries
 * @param {Date | string | number} now
 * @returns {Promise<AuditEntry[]>} the entries that weren't stored already
 */
export async function recordAudit(env, entries, now) {
  /** @type {AuditEntry[]} */
  const fresh = [];
  for (const entry of entries) {
    if (entry.actionType === "view") continue;
    const actor = actorOf(entry);
    const stored = await recordEvent(env, {
      delivery: `cf:${entry.id}`,
      source: "cloudflare",
      target: "cloudflare",
      action: `${entry.product}.${entry.actionType}`,
      actor,
      detail: detailOf(entry, actor),
      at: entry.time,
    });
    if (stored) fresh.push(entry);
  }
  const at = new Date(now).toISOString();
  await env.DB.prepare(
    `INSERT INTO cursors (name, position, updated_at) VALUES (?1, ?2, ?2)
     ON CONFLICT (name) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
  )
    .bind(CURSOR, at)
    .run();
  return fresh;
}
