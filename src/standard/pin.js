import { changeSetting } from "../settings/store.js";

/** @typedef {import("../settings/store.js").SettingsEnv} SettingsEnv */
/** @typedef {{ version: string, sha256: string }} Pin */

const SUPPORTED_SCHEMA = 2;
const VERSION = /^v\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BYTES = 1_000_000;

/** @param {string} version */
const assetUrl = version =>
  `https://github.com/oneloneraven/project-bootstrap/releases/download/${version}/standard.json`;

/** @param {string} text */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} version
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 * @returns {Promise<{ body: string } | { reason: string }>}
 */
async function download(version, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(assetUrl(version), { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return { reason: `Download failed: HTTP ${response.status}` };
    if (Number(response.headers.get("Content-Length") ?? 0) > MAX_BYTES) return { reason: "The asset is too large" };
    const body = await response.text();
    if (new TextEncoder().encode(body).length > MAX_BYTES) return { reason: "The asset is too large" };
    return { body };
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return { reason: timedOut ? "Download failed: timed out" : "Download failed: network error" };
  }
}

/**
 * @param {string} body
 * @param {string} version
 * @returns {string | null}
 */
function refusal(body, version) {
  /** @type {{ bootstrap?: unknown, version?: unknown }} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "The asset isn't valid JSON";
  }
  if (parsed === null || typeof parsed !== "object") return "The asset isn't valid JSON";
  if (parsed.bootstrap !== version) return `The asset says it is ${String(parsed.bootstrap)}, not ${version}`;
  if (parsed.version !== SUPPORTED_SCHEMA) return `Unsupported standard schema version ${String(parsed.version)}`;
  return null;
}

/**
 * @param {SettingsEnv} env
 * @returns {Promise<Pin | null | "unreadable">}
 */
async function currentPin(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'standard'").first();
  if (!row) return null;
  try {
    const pin = JSON.parse(String(row.value));
    return typeof pin?.version === "string" && typeof pin?.sha256 === "string" ? pin : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * @param {SettingsEnv} env
 * @param {{ version: string, sha256: string, email: string }} request
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function pinStandard(env, { version, sha256, email }, fetchImpl = fetch, timeoutMs = 10_000) {
  if (typeof version !== "string" || !VERSION.test(version)) {
    return { ok: false, reason: "version must look like v1.2.3" };
  }
  const expected = typeof sha256 === "string" ? sha256.toLowerCase() : "";
  if (!SHA256.test(expected)) return { ok: false, reason: "sha256 must be 64 hexadecimal characters" };

  const downloaded = await download(version, fetchImpl, timeoutMs);
  if ("reason" in downloaded) return { ok: false, reason: downloaded.reason };
  const actual = await sha256Hex(downloaded.body);
  if (actual !== expected) return { ok: false, reason: `Checksum mismatch: expected ${expected}, got ${actual}` };
  const refused = refusal(downloaded.body, version);
  if (refused) return { ok: false, reason: refused };

  /** @type {Pin} */
  const pin = { version, sha256: expected };
  const previous = await currentPin(env);
  try {
    await changeSetting(
      env,
      {
        email,
        key: "standard",
        from: previous === "unreadable" ? null : previous,
        to: pin,
        apply: db => [
          db
            .prepare(
              `INSERT INTO standard (version, sha256, body, verified_at) VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           ON CONFLICT (version) DO UPDATE SET sha256 = excluded.sha256, body = excluded.body, verified_at = excluded.verified_at`,
            )
            .bind(version, expected, downloaded.body),
          db
            .prepare(
              "INSERT INTO settings (key, value) VALUES ('standard', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            )
            .bind(JSON.stringify(pin)),
        ],
      },
      fetchImpl,
    );
  } catch (error) {
    console.error("Saving the standard failed", error instanceof Error ? error.message : error);
    return { ok: false, reason: "Couldn't save the standard" };
  }
  return { ok: true };
}

/**
 * @param {SettingsEnv} env
 * @returns {Promise<{ standard: Record<string, unknown>, version: string } | { unknown: string }>}
 */
export async function loadStandard(env) {
  const pin = await currentPin(env);
  if (!pin) return { unknown: "No standard pinned" };
  if (pin === "unreadable") return { unknown: "Pinned standard unreadable" };
  const row = await env.DB.prepare("SELECT body FROM standard WHERE version = ?1 AND sha256 = ?2")
    .bind(pin.version, pin.sha256)
    .first();
  if (!row) return { unknown: "Pinned standard missing" };
  const body = String(row.body);
  if ((await sha256Hex(body)) !== pin.sha256) return { unknown: "Pinned standard fails its checksum" };
  return { standard: JSON.parse(body), version: pin.version };
}
