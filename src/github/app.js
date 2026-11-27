export const API = "https://api.github.com";
export const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "oneloneraven-guardian",
};
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

/** @typedef {{ GITHUB_APP_ID?: string, GITHUB_APP_PRIVATE_KEY?: string, GITHUB_ORG?: string }} GithubEnv */

export class GithubUnavailable extends Error {}

/** @type {{ key: string, token: string, expiresAt: number } | null} */
let cached = null;

/** @param {Uint8Array | string} value */
function base64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** @param {string} pem a PKCS#8 private key */
async function importKey(pem) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), char => char.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/**
 * A short-lived JWT that authenticates as the App itself.
 * @param {string} appId
 * @param {string} pem a PKCS#8 private key
 * @param {number} [nowS]
 */
export async function appJwt(appId, pem, nowS = Math.floor(Date.now() / 1000)) {
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: nowS - 60, exp: nowS + 540, iss: appId }),
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importKey(pem),
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} method
 * @param {string} path
 * @param {string} jwt
 */
async function appCall(fetchImpl, method, path, jwt) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: { ...HEADERS, Authorization: `Bearer ${jwt}` },
  });
  if (!response.ok) throw new GithubUnavailable(`github-${response.status}`);
  return response.json();
}

/**
 * An installation token for the organisation, cached until five minutes before it expires.
 * @param {GithubEnv} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function installationToken(env, fetchImpl = fetch) {
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: pem, GITHUB_ORG: org } = env;
  if (!appId || !pem || !org) throw new GithubUnavailable("github-app-not-configured");
  const key = `${appId}/${org}`;
  if (cached && cached.key === key && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return cached.token;
  try {
    const jwt = await appJwt(appId, pem);
    const installation = await appCall(fetchImpl, "GET", `/orgs/${encodeURIComponent(org)}/installation`, jwt);
    const granted = await appCall(fetchImpl, "POST", `/app/installations/${installation.id}/access_tokens`, jwt);
    cached = { key, token: granted.token, expiresAt: Date.parse(granted.expires_at) };
    return granted.token;
  } catch (error) {
    if (error instanceof GithubUnavailable) throw error;
    throw new GithubUnavailable("github-unreachable");
  }
}

export function clearInstallationToken() {
  cached = null;
}
