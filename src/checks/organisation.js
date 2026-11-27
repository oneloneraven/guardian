import { codes, hookHost, list, outcomes, settle } from "./result.js";

/**
 * @typedef {import("../github/reader.js").Reader} Reader
 * @typedef {import("./result.js").Result} Result
 * @typedef {{
 *   read: Reader,
 *   org: string,
 *   live: any,
 *   standard: any,
 *   owners: string[],
 *   apps: string[],
 *   repositories: { name: string, modules: string[] }[],
 *   exempt: (match: string) => string | null,
 * }} OrgContext
 * @typedef {import("./result.js").Outcomes} Outcomes
 */

/**
 * @param {string} suffix
 * @param {(ctx: OrgContext, out: Outcomes) => Promise<Result>} run
 */
function kind(suffix, run) {
  return /** @param {OrgContext} ctx */ ctx => run(ctx, outcomes(`https://github.com/orgs/${ctx.org}${suffix}`));
}

/** @param {string[]} values */
const lower = values => new Set(values.map(value => value.toLowerCase()));

const members = kind("/people", async (ctx, out) => {
  const base = `/orgs/${ctx.org}`;
  const [everyone, admins, invitations] = await Promise.all([
    list(ctx.read, `${base}/members?role=all`, "the members", "Members read"),
    list(ctx.read, `${base}/members?role=admin`, "the owners", "Members read"),
    list(ctx.read, `${base}/invitations`, "the invitations", "Members read"),
  ]);
  const owners = lower(ctx.owners);
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const unreadables = [];
  if ("unreadable" in everyone) unreadables.push(everyone.unreadable);
  else {
    for (const { login } of everyone.items) {
      if (!owners.has(String(login).toLowerCase())) problems.push(`\`${login}\` is a member but not an owner`);
    }
  }
  if ("unreadable" in admins) unreadables.push(admins.unreadable);
  else {
    const adminLogins = lower(admins.items.map(admin => String(admin.login)));
    for (const owner of ctx.owners) {
      if (!adminLogins.has(owner.toLowerCase())) problems.push(`\`${owner}\` isn't an owner of the organisation`);
    }
  }
  if ("unreadable" in invitations) unreadables.push(invitations.unreadable);
  else {
    for (const invitation of invitations.items) {
      problems.push(invitation.login ? `\`${invitation.login}\` is invited` : "An email invitation is pending");
    }
  }
  return settle(out, problems, unreadables, "Only the owners are members, and there are no invitations");
});

const twoFactor = kind("/settings/security", async (ctx, out) => {
  const required = ctx.live.two_factor_requirement_enabled;
  if (required === undefined) return out.unknown("GitHub didn't show whether two-factor is required");
  if (required !== true) return out.fail("Two-factor isn't required");
  return out.pass("Two-factor is required. GitHub's API doesn't show whether only secure methods are allowed.");
});

const apps = kind("/settings/installations", async (ctx, out) => {
  const found = await list(ctx.read, `/orgs/${ctx.org}/installations`, "the installed Apps", "Administration read");
  if ("unreadable" in found) return out.unknown(found.unreadable);
  const allowed = lower([
    ...(ctx.standard.organisation?.apps ?? []).map((/** @type {{ slug: string }} */ app) =>
      app.slug.replaceAll("{owner}", ctx.org),
    ),
    ...ctx.repositories
      .filter(repository => repository.modules.includes("core"))
      .map(repository => `${repository.name}-release`),
    ...ctx.apps,
  ]);
  const problems = found.items
    .filter(installation => !allowed.has(String(installation.app_slug).toLowerCase()))
    .map(installation => `App \`${installation.app_slug}\` is installed`);
  return settle(out, problems, [], "Only expected Apps are installed");
});

const webhooks = kind("/settings/hooks", async (ctx, out) => {
  const hooks = await list(ctx.read, `/orgs/${ctx.org}/hooks`, "the organisation webhooks", "Webhooks read");
  if ("unreadable" in hooks) return out.unknown(hooks.unreadable);
  if (hooks.items.length === 0) return out.pass("No organisation webhooks");
  return out.fail(
    hooks.items
      .map(hook => {
        const host = hookHost(hook);
        return host
          ? `Organisation webhook to \`${host}\` added`
          : "Organisation webhook with an unreadable address added";
      })
      .join("; "),
  );
});

const secrets = kind("/settings/secrets/actions", async (ctx, out) => {
  const found = await list(ctx.read, `/orgs/${ctx.org}/actions/secrets`, "the organisation secrets", "Secrets read");
  if ("unreadable" in found) return out.unknown(found.unreadable);
  const known = new Set(
    (ctx.standard.organisation?.secrets ?? []).map((/** @type {{ name: string }} */ secret) => secret.name),
  );
  const problems = found.items
    .filter(secret => !known.has(secret.name) && ctx.exempt(secret.name) === null)
    .map(secret => `Unexpected organisation secret \`${secret.name}\``);
  return settle(out, problems, [], "Every organisation secret is expected");
});

const settings = kind("/settings/member_privileges", async (ctx, out) => {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const hidden = [];
  for (const [key, want] of Object.entries(
    /** @type {Record<string, unknown>} */ (ctx.standard.organisation?.settings ?? {}),
  )) {
    const found = ctx.live[key];
    if (found === undefined) hidden.push(key);
    else if (found !== want) problems.push(`\`${key}\` is \`${found}\`, expected \`${want}\``);
  }
  const unreadables = hidden.length > 0 ? [`GitHub didn't show ${codes(hidden)}`] : [];
  return settle(out, problems, unreadables, "Organisation settings match the standard");
});

/** @type {Record<string, (ctx: OrgContext) => Promise<Result>>} */
export const ORGANISATION_KINDS = {
  "org-members": members,
  "org-2fa": twoFactor,
  "org-apps": apps,
  "org-webhooks-none": webhooks,
  "org-secrets-known": secrets,
  "org-settings-match": settings,
};
