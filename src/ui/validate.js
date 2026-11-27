/** @typedef {Record<string, string>} FieldErrors */

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const CHECK = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_ID = /^[A-Za-z0-9]{1,64}$/;

/**
 * @param {{ target: string, check: string, match: string, reason: string }} fields
 * @returns {FieldErrors}
 */
export function checkException({ target, check, reason }) {
  /** @type {FieldErrors} */
  const errors = {};
  if (!target.trim()) errors.target = "Name the repository, or organisation.";
  else if (!REPOSITORY.test(target.trim())) errors.target = "That isn't a repository name.";
  if (!check.trim()) errors.check = "Name the check, such as visibility.";
  else if (!CHECK.test(check.trim())) errors.check = "Use the check's id: lower case letters, numbers and hyphens.";
  if (!reason.trim()) errors.reason = "Give a reason: every exception needs one.";
  return errors;
}

/**
 * @param {{ tokenId: string, name: string, purpose: string, repository: string }} fields
 * @returns {FieldErrors}
 */
export function checkToken({ tokenId, name, purpose, repository }) {
  /** @type {FieldErrors} */
  const errors = {};
  if (!tokenId.trim()) errors.tokenId = "Give the token's id from Cloudflare.";
  else if (!TOKEN_ID.test(tokenId.trim())) errors.tokenId = "A token id is letters and numbers only.";
  if (!name.trim()) errors.name = "Give the token's name.";
  if (!purpose.trim()) errors.purpose = "Say what the token is for.";
  if (repository.trim() && !REPOSITORY.test(repository.trim())) errors.repository = "That isn't a repository name.";
  return errors;
}

/**
 * @param {{ version: string, sha256: string }} fields
 * @returns {FieldErrors}
 */
export function checkPin({ version, sha256 }) {
  /** @type {FieldErrors} */
  const errors = {};
  if (!/^v\d+\.\d+\.\d+$/.test(version.trim())) errors.version = "Use a release tag such as v1.18.0.";
  if (!/^[0-9a-fA-F]{64}$/.test(sha256.trim())) errors.sha256 = "Paste the 64-character SHA-256 of standard.json.";
  return errors;
}

/**
 * @param {string} text
 * @returns {{ values: string[] } | { error: string }}
 */
export function parseNames(text) {
  const values = text.split(/[\s,]+/).filter(Boolean);
  const invalid = values.find(value => !LOGIN.test(value));
  return invalid ? { error: `${invalid} isn't a GitHub login or App slug.` } : { values };
}

/** @param {string} text */
const capitalise = text => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * @param {{ actor: string, key: string, to: unknown }} entry
 * @returns {string}
 */
export function describeChange({ actor, key, to }) {
  const who = capitalise(actor);
  const value = /** @type {Record<string, unknown> | null} */ (to && typeof to === "object" ? to : null);
  switch (key) {
    case "exceptions":
      return `${who} ${to === null ? "removed" : "added"} an exception`;
    case "tokens":
      return `${who} ${to === null ? "removed" : "added"} a known token`;
    case "standard":
      return `${who} pinned the standard to ${String(value?.version)}`;
    case "owners":
      return `${who} changed the owners`;
    case "check-alerts":
      return `${who} turned check alerts ${to === true ? "on" : "off"}`;
    case "apps":
      return `${who} changed the Apps`;
    case "repositories":
      return `${who} set ${String(value?.name)}'s expected visibility to ${String(value?.expectedVisibility)}`;
    default:
      return `${who} changed ${key}`;
  }
}
