import { raise } from "../alerts/outbox.js";
import { raiseFor } from "../alerts/raise-for.js";
import { saveResult } from "../results/store.js";
import { classify } from "./actions.js";
import { readAudit, recordAudit } from "./audit.js";

/**
 * @typedef {import("./audit.js").AuditEnv & import("../settings/store.js").SettingsEnv} WatchEnv
 * @typedef {{ readAudit: typeof readAudit, recordAudit: typeof recordAudit, raiseFor: typeof raiseFor }} WatchDeps
 */

const AUDIT_LINK = "https://dash.cloudflare.com/?to=/:account/audit-log";
const CORAXIA_PURPOSE = "coraxia infra";

/** @type {WatchDeps} */
const REAL = { readAudit, recordAudit, raiseFor };

/** @param {WatchEnv} env */
async function knownTokens(env) {
  const { results } = await env.DB.prepare("SELECT token_id, name, purpose, repository FROM known_tokens").all();
  return results.map(row => ({
    tokenId: String(row.token_id),
    name: String(row.name),
    purpose: String(row.purpose),
    repository: row.repository === null ? null : String(row.repository),
  }));
}

/**
 * @param {WatchEnv} env
 * @param {Date | string | number} now
 * @param {Partial<WatchDeps>} [overrides]
 * @returns {Promise<void>}
 */
export async function watchAudit(env, now, overrides = {}) {
  const deps = { ...REAL, ...overrides };
  const at = new Date(now).toISOString();
  const read = await deps.readAudit(env, now);
  const fresh = "entries" in read ? await deps.recordAudit(env, read.entries, now, read.complete) : [];
  const result =
    "entries" in read
      ? { status: /** @type {const} */ ("pass"), reason: "", link: AUDIT_LINK }
      : { status: /** @type {const} */ ("unknown"), reason: read.unreadable, link: AUDIT_LINK };
  const transition = await saveResult(env, { target: "cloudflare", check: "audit-log", result, by: "sweep", at });
  await deps.raiseFor(env, [transition]);
  if (fresh.length === 0) return;
  const tokens = await knownTokens(env);
  const coraxia = tokens.find(token => token.purpose.toLowerCase().startsWith(CORAXIA_PURPOSE))?.tokenId ?? "";
  for (const entry of fresh) {
    const { level, text } = classify(entry, tokens, coraxia);
    if (level === "record") continue;
    await raise(env, { kind: "cloudflare", target: "cloudflare", subject: `cf:${entry.id}`, text });
  }
}
