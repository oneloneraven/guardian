import { deliverPending } from "../alerts/outbox.js";
import { raiseFor } from "../alerts/raise-for.js";
import { parseRecord } from "../checks/expected.js";
import { checkRepository } from "../checks/run.js";
import { GithubUnavailable, installationToken } from "../github/app.js";
import { ReadError, reader as githubReader } from "../github/reader.js";
import { changeSetting } from "../settings/store.js";
import { loadStandard, pinStandard } from "../standard/pin.js";

/** @typedef {import("../settings/store.js").SettingsEnv} SettingsEnv */
/** @typedef {import("../github/reader.js").Reader} Reader */
/**
 * @typedef {{
 *   env: import("../checks/run.js").RunEnv,
 *   email: string,
 *   fetchImpl?: typeof fetch,
 *   readerFor?: () => Promise<Reader>,
 *   waitUntil?: (promise: Promise<unknown>) => void,
 * }} Context
 */

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const CHECK = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_ID = /^[A-Za-z0-9]{1,64}$/;
const BLOB_SHA = /^[0-9a-f]{40}$/;
const RECORD_PATH = ".bootstrap/record.json";
const RECORD_UNREADABLE = "Couldn't read the record from GitHub: try again in a minute.";

export class Invalid extends Error {}

class Unreadable extends Error {}

/**
 * @param {number} status
 * @param {unknown} body
 */
export const json = (status, body) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** @param {unknown} value */
const text = value => (typeof value === "string" ? value.trim() : "");

/**
 * @param {unknown} value
 * @param {string} field
 */
function required(value, field) {
  const trimmed = text(value);
  if (!trimmed) throw new Invalid(`${field} is required`);
  return trimmed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null}
 */
function optional(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Invalid(`${field} must be text`);
  return value.trim() || null;
}

/**
 * @param {SettingsEnv} env
 * @param {string} key
 * @returns {Promise<unknown>}
 */
async function readSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first();
  if (!row) return null;
  try {
    return JSON.parse(String(row.value));
  } catch {
    return null;
  }
}

/** @param {unknown} value */
const list = value => (Array.isArray(value) ? value : []);

/** @param {unknown} value */
function parsed(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/** @param {SettingsEnv} env */
export async function readSettings(env) {
  const all = async (/** @type {string} */ sql) => env.DB.prepare(sql).all();
  const [pin, loaded, owners, apps, alerts, repositories, exceptions, tokens, audit] = await Promise.all([
    readSetting(env, "standard"),
    loadStandard(env),
    readSetting(env, "owners"),
    readSetting(env, "apps"),
    readSetting(env, "check-alerts"),
    all(
      "SELECT name, expected_visibility AS expectedVisibility, accepted_record_sha AS acceptedRecordSha FROM repositories ORDER BY name",
    ),
    all('SELECT id, target, check_id AS "check", match, reason, created_at AS createdAt FROM exceptions ORDER BY id'),
    all("SELECT token_id AS tokenId, name, purpose, repository FROM known_tokens ORDER BY name"),
    all(
      "SELECT id, actor, key, from_value, to_value, changed_at, notified FROM settings_audit ORDER BY id DESC LIMIT 50",
    ),
  ]);
  const version = /** @type {{ version?: unknown } | null} */ (pin)?.version;
  const pinned = typeof version === "string" ? version : null;
  /** @type {{ version: string | null, unknown?: string } | null} */
  let standard = null;
  if (!("unknown" in loaded)) standard = { version: loaded.version };
  else if (loaded.unknown !== "No standard pinned") standard = { version: pinned, unknown: loaded.unknown };
  return {
    standard,
    owners: list(owners),
    apps: list(apps),
    alerts: { enabled: alerts === "on" },
    repositories: repositories.results,
    exceptions: exceptions.results,
    tokens: tokens.results,
    audit: audit.results.map(row => ({
      id: row.id,
      actor: row.actor,
      key: row.key,
      from: parsed(row.from_value),
      to: parsed(row.to_value),
      changedAt: row.changed_at,
      notified: row.notified === 1,
    })),
  };
}

/**
 * @param {Context} context
 * @param {"owners" | "apps"} key
 * @param {Record<string, unknown>} body
 */
export async function putNames({ env, email, fetchImpl }, key, body) {
  const values = body.values;
  if (!Array.isArray(values) || values.length > 100 || !values.every(v => typeof v === "string" && LOGIN.test(v))) {
    throw new Invalid("values must be GitHub logins or App slugs");
  }
  /** @type {Map<string, string>} */
  const unique = new Map();
  for (const value of /** @type {string[]} */ (values)) {
    if (!unique.has(value.toLowerCase())) unique.set(value.toLowerCase(), value);
  }
  const to = [...unique.values()];
  await changeSetting(
    env,
    {
      email,
      key,
      from: list(await readSetting(env, key)),
      to,
      apply: db => [
        db
          .prepare(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          )
          .bind(key, JSON.stringify(to)),
      ],
    },
    fetchImpl,
  );
  return json(200, { ok: true });
}

/**
 * @param {Context} context
 * @param {Record<string, unknown>} body
 */
export async function putAlerts({ env, email, fetchImpl }, body) {
  const enabled = body.enabled;
  if (typeof enabled !== "boolean") throw new Invalid("enabled must be true or false");
  await changeSetting(
    env,
    {
      email,
      key: "check-alerts",
      from: (await readSetting(env, "check-alerts")) === "on",
      to: enabled,
      apply: db => [
        db
          .prepare(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          )
          .bind("check-alerts", JSON.stringify(enabled ? "on" : "off")),
      ],
    },
    fetchImpl,
  );
  return json(200, { ok: true });
}

/**
 * @param {Context} context
 * @param {string} name
 * @param {Record<string, unknown>} body
 */
export async function putRepository({ env, email, fetchImpl }, name, body) {
  if (!REPOSITORY.test(name)) throw new Invalid("name must be a repository name");
  const visibility = body.expectedVisibility;
  if (visibility !== "public" && visibility !== "private") {
    throw new Invalid("expectedVisibility must be public or private");
  }
  const previous = await env.DB.prepare("SELECT expected_visibility FROM repositories WHERE name = ?1")
    .bind(name)
    .first();
  await changeSetting(
    env,
    {
      email,
      key: "repositories",
      from: previous ? { name, expectedVisibility: previous.expected_visibility } : null,
      to: { name, expectedVisibility: visibility },
      apply: db => [
        db
          .prepare(
            "INSERT INTO repositories (name, expected_visibility) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET expected_visibility = excluded.expected_visibility",
          )
          .bind(name, visibility),
      ],
    },
    fetchImpl,
  );
  return json(200, { ok: true });
}

/**
 * @param {Context} context
 * @param {Record<string, unknown>} body
 */
export async function postException({ env, email, fetchImpl }, body) {
  const target = required(body.target, "target");
  if (!REPOSITORY.test(target)) throw new Invalid("target must be a repository name or organisation");
  const check = text(body.check);
  if (!CHECK.test(check)) throw new Invalid("check must be a check id");
  const match = optional(body.match, "match");
  const reason = required(body.reason, "reason");
  await changeSetting(
    env,
    {
      email,
      key: "exceptions",
      from: null,
      to: { target, check, match, reason },
      apply: db => [
        db
          .prepare("INSERT INTO exceptions (target, check_id, match, reason) VALUES (?1, ?2, ?3, ?4)")
          .bind(target, check, match, reason),
      ],
    },
    fetchImpl,
  );
  return json(201, { ok: true });
}

/**
 * @param {Context} context
 * @param {string} id
 */
export async function deleteException({ env, email, fetchImpl }, id) {
  const row = /^\d+$/.test(id)
    ? await env.DB.prepare('SELECT target, check_id AS "check", match, reason FROM exceptions WHERE id = ?1')
        .bind(Number(id))
        .first()
    : null;
  if (!row) return json(404, { error: "No such exception" });
  await changeSetting(
    env,
    {
      email,
      key: "exceptions",
      from: row,
      to: null,
      apply: db => [db.prepare("DELETE FROM exceptions WHERE id = ?1").bind(Number(id))],
    },
    fetchImpl,
  );
  return json(200, { ok: true });
}

/**
 * @param {Context} context
 * @param {Record<string, unknown>} body
 */
export async function postToken({ env, email, fetchImpl }, body) {
  const tokenId = text(body.tokenId);
  if (!TOKEN_ID.test(tokenId)) throw new Invalid("tokenId must be a token id");
  const name = required(body.name, "name");
  const purpose = required(body.purpose, "purpose");
  const repository = optional(body.repository, "repository");
  if (repository !== null && !REPOSITORY.test(repository)) throw new Invalid("repository must be a repository name");
  if (await env.DB.prepare("SELECT 1 FROM known_tokens WHERE token_id = ?1").bind(tokenId).first()) {
    return json(409, { error: "tokenId is already known" });
  }
  try {
    await changeSetting(
      env,
      {
        email,
        key: "tokens",
        from: null,
        to: { tokenId, name, purpose, repository },
        apply: db => [
          db
            .prepare("INSERT INTO known_tokens (token_id, name, purpose, repository) VALUES (?1, ?2, ?3, ?4)")
            .bind(tokenId, name, purpose, repository),
        ],
      },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE/.test(error.message)) return json(409, { error: "tokenId is already known" });
    throw error;
  }
  return json(201, { ok: true });
}

/**
 * @param {Context} context
 * @param {string} tokenId
 */
export async function deleteToken({ env, email, fetchImpl }, tokenId) {
  const row = TOKEN_ID.test(tokenId)
    ? await env.DB.prepare(
        "SELECT token_id AS tokenId, name, purpose, repository FROM known_tokens WHERE token_id = ?1",
      )
        .bind(tokenId)
        .first()
    : null;
  if (!row) return json(404, { error: "No such token" });
  await changeSetting(
    env,
    {
      email,
      key: "tokens",
      from: row,
      to: null,
      apply: db => [db.prepare("DELETE FROM known_tokens WHERE token_id = ?1").bind(tokenId)],
    },
    fetchImpl,
  );
  return json(200, { ok: true });
}

/**
 * @param {Context} context
 * @param {Record<string, unknown>} body
 */
export async function postStandard({ env, email, fetchImpl }, body) {
  const result = await pinStandard(
    env,
    { version: /** @type {string} */ (body.version), sha256: /** @type {string} */ (body.sha256), email },
    fetchImpl,
  );
  return result.ok ? json(200, { ok: true }) : json(422, { error: result.reason });
}

/**
 * @param {import("../checks/expected.js").AcceptedRecord} record
 * @param {string} sha
 */
const shown = (record, sha) => ({ sha, modules: record.modules, flags: record.flags });

/**
 * @param {Context} context
 * @returns {Promise<Reader>}
 */
async function recordReader({ env, readerFor }) {
  try {
    return readerFor ? await readerFor() : githubReader(await installationToken(env));
  } catch (error) {
    if (error instanceof GithubUnavailable) throw new Unreadable();
    throw error;
  }
}

/**
 * @param {Context} context
 * @param {string} name
 * @returns {Promise<{ row: Record<string, unknown> } | { missing: true }>}
 */
async function knownRepository({ env }, name) {
  const row = REPOSITORY.test(name)
    ? await env.DB.prepare("SELECT name, accepted_record_sha FROM repositories WHERE name = ?1").bind(name).first()
    : null;
  return row ? { row } : { missing: true };
}

/**
 * The live record as GitHub has it now, or null when the repository has none.
 * @param {Context} context
 * @param {Reader} read
 * @param {string} name
 * @returns {Promise<{ sha: string, record: import("../checks/expected.js").AcceptedRecord | null } | null>}
 */
async function liveRecord({ env }, read, name) {
  const repo = `${env.GITHUB_ORG || "oneloneraven"}/${name}`;
  const { status, body } = await read.get(`/repos/${repo}`);
  if (status !== 200) throw new Unreadable();
  /** @type {{ text: string, sha: string } | null} */
  let file;
  try {
    file = await read.file(repo, RECORD_PATH, body.default_branch);
  } catch (error) {
    if (error instanceof ReadError) throw new Unreadable();
    throw error;
  }
  if (!file) return null;
  try {
    return { sha: file.sha, record: parseRecord(file.text) };
  } catch {
    return { sha: file.sha, record: null };
  }
}

/**
 * @param {Context} context
 * @param {Reader} read
 * @param {string} name
 * @param {unknown} sha
 * @returns {Promise<{ sha: string, modules: string[], flags: Record<string, boolean> } | null>}
 */
async function acceptedRecord({ env }, read, name, sha) {
  if (typeof sha !== "string" || !sha) return null;
  try {
    const text = await read.blob(`${env.GITHUB_ORG || "oneloneraven"}/${name}`, sha);
    return text === null ? null : shown(parseRecord(text), sha);
  } catch (error) {
    if (error instanceof ReadError) throw new Unreadable();
    return null;
  }
}

/**
 * @param {Context} context
 * @param {string} name
 */
export async function getRecord(context, name) {
  const known = await knownRepository(context, name);
  if ("missing" in known) return json(404, { error: "No such repository" });
  try {
    const read = await recordReader(context);
    const live = await liveRecord(context, read, name);
    if (live && !live.record) return json(422, { error: "The record in the repository isn't a valid record" });
    return json(200, {
      accepted: await acceptedRecord(context, read, name, known.row.accepted_record_sha),
      live: live?.record ? shown(live.record, live.sha) : null,
    });
  } catch (error) {
    if (error instanceof Unreadable) return json(502, { error: RECORD_UNREADABLE });
    throw error;
  }
}

/**
 * @param {Context} context
 * @param {string} name
 * @param {Record<string, unknown>} body
 */
export async function putRecord(context, name, body) {
  const { env, email, fetchImpl, waitUntil } = context;
  const sha = body.sha;
  if (typeof sha !== "string" || !BLOB_SHA.test(sha)) throw new Invalid("sha must be a commit blob sha");
  const known = await knownRepository(context, name);
  if ("missing" in known) return json(404, { error: "No such repository" });
  let read;
  try {
    read = await recordReader(context);
    const live = await liveRecord(context, read, name);
    if (!live || live.sha !== sha) return json(409, { error: "The record changed again: reload" });
    if (!live.record) return json(422, { error: "The record in the repository isn't a valid record" });
  } catch (error) {
    if (error instanceof Unreadable) return json(502, { error: RECORD_UNREADABLE });
    throw error;
  }
  await changeSetting(
    env,
    {
      email,
      key: "records",
      from: known.row.accepted_record_sha ?? null,
      to: { name, sha },
      apply: db => [db.prepare("UPDATE repositories SET accepted_record_sha = ?1 WHERE name = ?2").bind(sha, name)],
    },
    fetchImpl,
  );
  const recheck = (async () => {
    try {
      await raiseFor(env, await checkRepository(env, /** @type {Reader} */ (read), name, "event"));
      await deliverPending(env, fetchImpl);
    } catch (error) {
      console.error("Re-check after accepting a record failed", error instanceof Error ? error.message : error);
    }
  })();
  if (waitUntil) waitUntil(recheck);
  else await recheck;
  return json(200, { ok: true });
}

/** @param {Context} context */
export async function getResults({ env }) {
  const loaded = await loadStandard(env);
  /** @type {Map<string, string>} */
  const titles = new Map([["record-accepted", "Accepted record"]]);
  if ("standard" in loaded) {
    for (const check of /** @type {{ id: string, title?: string }[]} */ (loaded.standard.checks ?? [])) {
      if (check.title && !titles.has(check.id)) titles.set(check.id, check.title);
    }
  }
  const { results } = await env.DB.prepare(
    `SELECT target, check_id AS "check", status, reason, link, checked_at AS checkedAt FROM results
     ORDER BY CASE status WHEN 'fail' THEN 0 WHEN 'unknown' THEN 1 WHEN 'skipped' THEN 2 ELSE 3 END, target, check_id`,
  ).all();
  return json(200, {
    results: results.map(row => ({
      target: row.target,
      check: row.check,
      title: titles.get(String(row.check)) ?? row.check,
      status: row.status,
      reason: row.reason,
      link: row.link,
      checkedAt: row.checkedAt,
    })),
  });
}

/** @param {Context} context */
export async function getEvents({ env }) {
  const { results } = await env.DB.prepare(
    "SELECT target, action, actor, detail, occurred_at AS at FROM security_events ORDER BY occurred_at DESC, id DESC LIMIT 50",
  ).all();
  return json(200, { events: results });
}
