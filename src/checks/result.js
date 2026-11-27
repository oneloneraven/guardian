/**
 * @typedef {import("../github/reader.js").Reader} Reader
 * @typedef {{ status: "pass" | "fail" | "unknown" | "skipped", reason: string, link: string | null }} Result
 * @typedef {{ pass: (reason: string) => Result, fail: (reason: string) => Result, unknown: (reason: string) => Result }} Outcomes
 * @typedef {{ items: any[] } | { unreadable: string }} Listing
 */

/**
 * @param {string} link
 * @returns {Outcomes}
 */
export function outcomes(link) {
  return {
    pass: reason => ({ status: "pass", reason, link }),
    fail: reason => ({ status: "fail", reason, link }),
    unknown: reason => ({ status: "unknown", reason, link }),
  };
}

/**
 * @param {string} what
 * @param {number} status
 * @param {string} permission
 */
export function unreadable(what, status, permission) {
  if (status === 403) return `Can't read ${what}: the GitHub App needs the \`${permission}\` permission`;
  return `Couldn't read ${what} (${status === 0 ? "no answer" : `HTTP ${status}`})`;
}

/** @param {string} path */
const paged = path => `${path}${path.includes("?") ? "&" : "?"}per_page=100`;

/**
 * @param {Reader} read
 * @param {string} path
 * @param {string} what
 * @param {string} permission
 * @returns {Promise<Listing>}
 */
export async function list(read, path, what, permission) {
  const { status, items } = await read.all(paged(path));
  return status === 200 ? { items } : { unreadable: unreadable(what, status, permission) };
}

/**
 * @param {Outcomes} out
 * @param {string[]} problems
 * @param {string[]} unreadables
 * @param {string} passReason
 */
export function settle(out, problems, unreadables, passReason) {
  if (problems.length > 0) return out.fail(problems.join("; "));
  if (unreadables.length > 0) return out.unknown(unreadables.join("; "));
  return out.pass(passReason);
}

/** @param {string[]} values */
export const codes = values => values.map(value => `\`${value}\``).join(", ");

/** @param {any} hook */
export function hookHost(hook) {
  try {
    return new URL(hook.config?.url).hostname;
  } catch {
    return null;
  }
}
