import { API, HEADERS } from "./app.js";

const TIMEOUT_MS = 10_000;
const MAX_PAGES = 20;

export class ReadError extends Error {
  /** @param {string} what @param {number} status */
  constructor(what, status) {
    super(`read-${status}`);
    this.what = what;
    this.status = status;
  }
}

/**
 * @typedef {{ status: number, body: any }} Answer
 * @typedef {{ status: number, items: any[] }} Pages
 * @typedef {{
 *   get: (path: string) => Promise<Answer>,
 *   all: (path: string) => Promise<Pages>,
 *   file: (repo: string, path: string, ref?: string) => Promise<{ text: string, sha: string } | null>,
 *   blob: (repo: string, sha: string) => Promise<string | null>,
 * }} Reader
 */

/** @param {string} base64 */
function decode(base64) {
  return new TextDecoder().decode(Uint8Array.from(atob(base64.replace(/\s+/g, "")), char => char.charCodeAt(0)));
}

/** @param {string | null} header */
function nextLink(header) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(header ?? "");
  return match?.[1].startsWith(`${API}/`) ? match[1] : null;
}

/**
 * Read-only GitHub access. `get` and `all` never throw: a failure comes back as its status, and a network error or
 * timeout as status 0.
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 * @returns {Reader}
 */
export function reader(token, fetchImpl = fetch) {
  /** @param {string} url */
  async function request(url) {
    try {
      const response = await fetchImpl(url, {
        headers: { ...HEADERS, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return {
        status: response.status,
        body: response.ok ? await response.json() : null,
        next: nextLink(response.headers.get("Link")),
      };
    } catch {
      return { status: 0, body: null, next: null };
    }
  }

  /** @param {string} path */
  async function get(path) {
    const { status, body } = await request(`${API}${path}`);
    return { status, body };
  }

  /** @param {string} path */
  async function all(path) {
    /** @type {any[]} */
    const items = [];
    /** @type {string | null} */
    let url = `${API}${path}`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const { status, body, next } = await request(url);
      if (status !== 200) return { status, items };
      const list = Array.isArray(body) ? body : (Object.values(body ?? {}).find(Array.isArray) ?? []);
      items.push(...list);
      url = next;
    }
    return { status: 200, items };
  }

  /**
   * A file's text and blob sha, or null when it doesn't exist.
   * @param {string} repo
   * @param {string} path
   * @param {string} [ref]
   */
  async function file(repo, path, ref) {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const { status, body } = await get(
      `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${query}`,
    );
    if (status === 404) return null;
    if (status !== 200 || typeof body?.content !== "string") throw new ReadError(path, status);
    return { text: decode(body.content), sha: body.sha };
  }

  /**
   * A git blob's text, or null when it doesn't exist.
   * @param {string} repo
   * @param {string} sha
   */
  async function blob(repo, sha) {
    const { status, body } = await get(`/repos/${repo}/git/blobs/${encodeURIComponent(sha)}`);
    if (status === 404) return null;
    if (status !== 200 || typeof body?.content !== "string") throw new ReadError(sha, status);
    return decode(body.content);
  }

  return { get, all, file, blob };
}
