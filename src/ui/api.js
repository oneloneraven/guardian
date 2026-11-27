/**
 * @typedef {{ version: string | null, unknown?: string } | null} StandardState
 * @typedef {{ name: string, expectedVisibility: "public" | "private" | null, acceptedRecordSha: string | null }} Repository
 * @typedef {{ id: number, target: string, check: string, match: string | null, reason: string, createdAt: string }} Exception
 * @typedef {{ tokenId: string, name: string, purpose: string, repository: string | null }} KnownToken
 * @typedef {{ id: number, actor: string, key: string, from: unknown, to: unknown, changedAt: string, notified: boolean }} AuditEntry
 * @typedef {{ standard: StandardState, owners: string[], apps: string[], alerts: { enabled: boolean }, repositories: Repository[], exceptions: Exception[], tokens: KnownToken[], audit: AuditEntry[] }} Settings
 */

export class ApiError extends Error {}

const SIGNED_OUT = "You're not signed in to Guardian any more: reload the page to sign in again.";
const UNREACHABLE = "Couldn't reach Guardian: check your connection and try again.";
const FAILED = "Guardian couldn't do that just now: try again in a minute.";
const GONE = "That's already gone: reload the page.";

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function request(method, path, body) {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(path, {
      method,
      redirect: "manual",
      ...(body !== undefined && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(UNREACHABLE);
  }
  /** @type {any} */
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  if (response.ok) return payload;
  if (response.status === 404 && payload?.error) throw new ApiError(GONE);
  if (response.type === "opaqueredirect" || response.status === 403 || response.status === 404) {
    throw new ApiError(SIGNED_OUT);
  }
  if ((response.status === 400 || response.status === 409 || response.status === 422) && payload?.error) {
    throw new ApiError(String(payload.error));
  }
  throw new ApiError(FAILED);
}

/** @returns {Promise<Settings>} */
export const getSettings = () => request("GET", "/api/settings");

/** @param {{ version: string, sha256: string }} pin */
export const pinStandard = pin => request("POST", "/api/standard", pin);

/**
 * @param {"owners" | "apps"} key
 * @param {string[]} values
 */
export const putNames = (key, values) => request("PUT", `/api/${key}`, { values });

/**
 * @param {string} name
 * @param {"public" | "private"} expectedVisibility
 */
export const putRepository = (name, expectedVisibility) =>
  request("PUT", `/api/repositories/${encodeURIComponent(name)}`, { expectedVisibility });

/** @param {{ target: string, check: string, match?: string, reason: string }} exception */
export const addException = exception => request("POST", "/api/exceptions", exception);

/** @param {number} id */
export const removeException = id => request("DELETE", `/api/exceptions/${id}`);

/** @param {{ tokenId: string, name: string, purpose: string, repository?: string }} token */
export const addToken = token => request("POST", "/api/tokens", token);

/** @param {string} tokenId */
export const removeToken = tokenId => request("DELETE", `/api/tokens/${encodeURIComponent(tokenId)}`);

/** @param {boolean} enabled */
export const putAlerts = enabled => request("PUT", "/api/alerts", { enabled });
