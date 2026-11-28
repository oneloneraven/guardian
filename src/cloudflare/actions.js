import { actorOf } from "./audit.js";

/**
 * @typedef {import("./audit.js").AuditEntry} AuditEntry
 * @typedef {{ tokenId: string, name: string, purpose: string, repository: string | null }} KnownToken
 * @typedef {{ level: "alert" | "info" | "record", text: string }} Classification
 * @typedef {{ entry: AuditEntry, actor: string, token: KnownToken | undefined, coraxia: boolean, key: string }} Context
 * @typedef {{ name: string, matches: (key: string) => boolean, decide: (context: Context) => Classification }} Row
 */

/** @param {string} value */
const squash = value => value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

/** @param {string} actionType */
const past = actionType =>
  ({ create: "created", update: "changed", delete: "deleted" })[actionType.toLowerCase()] ?? `${actionType} on`;

/** @param {string} actionType */
const base = actionType =>
  ({ create: "create", update: "change", delete: "delete" })[actionType.toLowerCase()] ?? actionType;

/** @param {string} value */
const code = value => `\`${value}\``;

/** @param {Context} context @param {string} what */
function alert({ entry, actor }, what) {
  const failed = entry.actionResult.toLowerCase() === "failure";
  const verb = failed ? `tried to ${base(entry.actionType)}` : past(entry.actionType);
  return /** @type {Classification} */ ({ level: "alert", text: `${code(actor)} ${verb} ${what}` });
}

/** @param {Context} context @param {string} what @returns {Classification} */
const record = ({ actor, entry }, what) => ({
  level: "record",
  text: `${code(actor)} ${past(entry.actionType)} ${what}`,
});

/** @param {Context} context */
const subject = ({ entry }) => `${entry.product} ${entry.resourceType} ${code(entry.resourceId)}`.replaceAll("  ", " ");

/** @param {Context} context @param {string} label */
function managed({ entry, coraxia, actor }, label) {
  const failed = entry.actionResult.toLowerCase() === "failure";
  if (coraxia && !failed) {
    return /** @type {Classification} */ ({
      level: "info",
      text: `Coraxia changed ${entry.product} ${code(entry.resourceId)}: ${entry.description || entry.actionType}`,
    });
  }
  const verb = failed ? `tried to ${base(entry.actionType)}` : past(entry.actionType);
  return /** @type {Classification} */ ({
    level: "alert",
    text: `${code(actor)} ${verb} ${label} ${code(entry.resourceId)}`,
  });
}

/** @param {Context} context @param {string} script */
function ownWorker({ token }, script) {
  const repository = token?.repository?.toLowerCase();
  const name = script.toLowerCase();
  return Boolean(repository) && (name === repository || name.startsWith(`${repository}-`));
}

/** @param {Context} context @returns {Classification} */
function worker(context) {
  const { entry, token, key } = context;
  const script = entry.resourceId;
  if (key.includes("route")) {
    return token?.repository && entry.actionResult.toLowerCase() !== "failure"
      ? record(context, `Worker route ${code(script)}`)
      : alert(context, `Worker route ${code(script)}`);
  }
  const kind = key.includes("secret") ? "secrets" : key.includes("setting") ? "settings" : "deploy";
  const failed = entry.actionResult.toLowerCase() === "failure";
  if (!failed && ownWorker(context, script)) return record(context, `Worker ${code(script)} (${kind})`);
  const phrase =
    kind === "deploy"
      ? `${failed ? "deploy" : "deployed"} Worker ${code(script)}`
      : `${failed ? "change" : "changed"} ${kind} of Worker ${code(script)}`;
  return { level: "alert", text: `${code(context.actor)} ${failed ? "tried to " : ""}${phrase}` };
}

/** @param {Context} context @returns {Classification} */
function d1(context) {
  const { entry, key } = context;
  const description = squash(entry.description);
  if (key.includes("timetravel") || key.includes("restore") || description.includes("restore")) {
    return alert({ ...context, entry: { ...entry, actionType: "restore" } }, `${subject(context)}`);
  }
  if ((key.includes("query") || description.includes("query")) && entry.actionResult.toLowerCase() !== "failure")
    return record(context, subject(context));
  return alert(context, `D1 ${entry.resourceType} ${code(entry.resourceId)}`);
}

/** @param {Context} context @returns {Classification} */
function dns({ entry, token, actor }) {
  const routine = token && squash(token.purpose).includes("infra") && entry.actionResult.toLowerCase() !== "failure";
  const text = `${code(actor)} ${past(entry.actionType)} DNS ${entry.resourceType} ${code(entry.resourceId)}`;
  return /** @type {Classification} */ ({ level: routine ? "record" : "alert", text });
}

/** @param {string} what @returns {(context: Context) => Classification} */
const storage = what => context =>
  context.entry.actionType.toLowerCase() === "view" && context.entry.actionResult.toLowerCase() !== "failure"
    ? record(context, `${what} ${code(context.entry.resourceId)}`)
    : alert(context, `${what} ${code(context.entry.resourceId)}`);

/** @type {Row[]} */
export const ROWS = [
  {
    name: "access",
    matches: key => ["access", "zerotrust", "cloudflareone"].some(part => key.includes(part)),
    decide: context => managed(context, "Access"),
  },
  {
    name: "turnstile",
    matches: key => key.includes("turnstile") || key.includes("challengewidget"),
    decide: context => managed(context, "Turnstile widget"),
  },
  {
    name: "api-tokens",
    matches: key =>
      key.startsWith("tokens") || key.includes("apitoken") || key.includes("usertoken") || key.includes("accounttoken"),
    decide: context => alert(context, `API token ${code(context.entry.resourceId)}`),
  },
  {
    name: "members",
    matches: key => ["member", "role", "invite"].some(part => key.includes(part)),
    decide: context =>
      alert(context, `account ${context.entry.resourceType || "member"} ${code(context.entry.resourceId)}`),
  },
  {
    name: "account-settings",
    matches: key => key.includes("accountsetting") || key.startsWith("account"),
    decide: context => alert(context, `account setting ${code(context.entry.resourceType)}`),
  },
  { name: "d1", matches: key => key.includes("d1"), decide: d1 },
  { name: "kv", matches: key => key.includes("kv"), decide: storage("KV namespace") },
  { name: "r2", matches: key => key.includes("r2"), decide: storage("R2 bucket") },
  { name: "cache", matches: key => key.includes("cache"), decide: storage("cache setting") },
  { name: "workers", matches: key => key.includes("worker"), decide: worker },
  { name: "dns", matches: key => key.includes("dns"), decide: dns },
];

/**
 * @param {AuditEntry} entry
 * @param {KnownToken[]} knownTokens
 * @param {string} [coraxiaApplyTokenId]
 * @returns {Classification}
 */
export function classify(entry, knownTokens, coraxiaApplyTokenId) {
  const key = squash(`${entry.product} ${entry.resourceType}`);
  const row = ROWS.find(candidate => candidate.matches(key));
  if (!row) {
    return {
      level: "alert",
      text: `Unrecognised Cloudflare action ${code(entry.actionType)} on ${code(entry.product)}/${code(entry.resourceType)}`,
    };
  }
  return row.decide({
    entry,
    actor: actorOf(entry),
    token: entry.tokenId ? knownTokens.find(known => known.tokenId === entry.tokenId) : undefined,
    coraxia: Boolean(coraxiaApplyTokenId) && entry.tokenId === coraxiaApplyTokenId,
    key,
  });
}
