/** @typedef {{ target: string, action: string, actor: string | null, detail: string, scope: "repository" | "organisation" }} Summary */

const WATCHED = new Set([
  "repository",
  "repository_ruleset",
  "member",
  "organization",
  "deploy_key",
  "security_and_analysis",
  "installation",
  "installation_repositories",
  "push",
]);
const ORGANISATION_EVENTS = new Set(["organization", "installation", "installation_repositories"]);
const RECORD_PATH = ".bootstrap/record.json";

/** @param {unknown} value */
const clean = value =>
  String(value ?? "")
    .replaceAll("@", " ")
    .replaceAll("`", "'");

/** @param {unknown} value */
const code = value => `\`${clean(value)}\``;

/**
 * @param {any} payload
 * @param {string} event
 * @param {string | null} actor
 * @returns {string}
 */
function describe(event, payload, actor) {
  const who = actor ? code(actor) : "Someone";
  const action = payload.action;
  switch (`${event}.${action}`) {
    case "deploy_key.created":
      return `${who} added deploy key ${code(payload.key?.title)}`;
    case "deploy_key.deleted":
      return `${who} removed deploy key ${code(payload.key?.title)}`;
    case "repository.publicized":
      return `${who} made the repository public`;
    case "repository.privatized":
      return `${who} made the repository private`;
    case "member.added":
      return `${who} added collaborator ${code(payload.member?.login)}`;
    case "member.removed":
      return `${who} removed collaborator ${code(payload.member?.login)}`;
    case "organization.member_invited":
      return payload.invitation?.login
        ? `${who} invited ${code(payload.invitation.login)}`
        : `${who} invited an email address`;
    case "organization.member_added":
      return `${who} added member ${code(payload.membership?.user?.login)}`;
    case "organization.member_removed":
      return `${who} removed member ${code(payload.membership?.user?.login)}`;
    case "repository_ruleset.created":
      return `${who} created ruleset ${code(payload.repository_ruleset?.name)}`;
    case "repository_ruleset.edited":
      return `${who} changed ruleset ${code(payload.repository_ruleset?.name)}`;
    case "repository_ruleset.deleted":
      return `${who} deleted ruleset ${code(payload.repository_ruleset?.name)}`;
    default:
      return `${who}: ${event}${action ? ` ${clean(action)}` : ""}`;
  }
}

/** @param {any} payload */
function touchesRecord(payload) {
  const branch = `refs/heads/${payload.repository?.default_branch}`;
  if (!payload.repository?.default_branch || payload.ref !== branch) return false;
  return (payload.commits ?? []).some((/** @type {any} */ commit) =>
    [commit.added, commit.modified, commit.removed].some(files => Array.isArray(files) && files.includes(RECORD_PATH)),
  );
}

/**
 * @param {string} event
 * @param {any} payload
 * @returns {Summary | null}
 */
export function summarise(event, payload) {
  if (!WATCHED.has(event) || payload === null || typeof payload !== "object") return null;
  const actor = typeof payload.sender?.login === "string" ? payload.sender.login : null;
  const who = actor ? code(actor) : "Someone";
  if (event === "push") {
    if (!touchesRecord(payload)) return null;
    return {
      target: String(payload.repository.name),
      action: "push",
      actor,
      detail: `${who} changed ${code(RECORD_PATH)}`,
      scope: "repository",
    };
  }
  const organisation = ORGANISATION_EVENTS.has(event) || typeof payload.repository?.name !== "string";
  return {
    target: organisation ? "organisation" : payload.repository.name,
    action: payload.action ? `${event}.${payload.action}` : event,
    actor,
    detail: describe(event, payload, actor),
    scope: organisation ? "organisation" : "repository",
  };
}
