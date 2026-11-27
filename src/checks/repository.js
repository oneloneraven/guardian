import { parseRecord } from "./expected.js";

/**
 * @typedef {import("../github/reader.js").Reader} Reader
 * @typedef {import("./expected.js").Expected} Expected
 * @typedef {{ status: "pass" | "fail" | "unknown" | "skipped", reason: string, link: string | null }} Result
 * @typedef {{
 *   read: Reader,
 *   repo: string,
 *   live: any,
 *   expected: Expected | { unknown: string },
 *   owners: string[],
 *   expectedVisibility: "public" | "private" | null,
 *   acceptedSha: string | null,
 *   liveRecord: { sha: string, text: string } | null,
 *   exempt: (match: string) => string | null,
 * }} RepoContext
 * @typedef {{ pass: (reason: string) => Result, fail: (reason: string) => Result, unknown: (reason: string) => Result }} Outcomes
 * @typedef {{ items: any[] } | { unreadable: string }} Listing
 */

const RECORD_PATH = ".bootstrap/record.json";

/**
 * @param {RepoContext} ctx
 * @param {string} suffix
 * @returns {Outcomes}
 */
function outcomes(ctx, suffix) {
  const link = `https://github.com/${ctx.repo}${suffix}`;
  return {
    pass: reason => ({ status: "pass", reason, link }),
    fail: reason => ({ status: "fail", reason, link }),
    unknown: reason => ({ status: "unknown", reason, link }),
  };
}

/**
 * @param {string} suffix
 * @param {(ctx: RepoContext, out: Outcomes) => Promise<Result>} run
 */
function kind(suffix, run) {
  return /** @param {RepoContext} ctx */ ctx => run(ctx, outcomes(ctx, suffix));
}

/**
 * @param {string} suffix
 * @param {(ctx: RepoContext, out: Outcomes, expected: Expected) => Promise<Result>} run
 */
function expectingKind(suffix, run) {
  return kind(suffix, (ctx, out) =>
    "unknown" in ctx.expected ? Promise.resolve(out.unknown(ctx.expected.unknown)) : run(ctx, out, ctx.expected),
  );
}

/**
 * @param {string} what
 * @param {number} status
 * @param {string} permission
 */
function unreadable(what, status, permission) {
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
async function list(read, path, what, permission) {
  const { status, items } = await read.all(paged(path));
  return status === 200 ? { items } : { unreadable: unreadable(what, status, permission) };
}

/**
 * @param {Outcomes} out
 * @param {string[]} problems
 * @param {string[]} unreadables
 * @param {string} passReason
 */
function settle(out, problems, unreadables, passReason) {
  if (problems.length > 0) return out.fail(problems.join("; "));
  if (unreadables.length > 0) return out.unknown(unreadables.join("; "));
  return out.pass(passReason);
}

/** @param {string[]} values */
const codes = values => values.map(value => `\`${value}\``).join(", ");

/**
 * @param {any} ruleset
 * @param {string} defaultBranch
 */
function coversDefaultBranch(ruleset, defaultBranch) {
  /** @param {string} pattern */
  const matches = pattern => ["~DEFAULT_BRANCH", "~ALL", `refs/heads/${defaultBranch}`].includes(pattern);
  const condition = ruleset.conditions?.ref_name ?? {};
  return (condition.include ?? []).some(matches) && !(condition.exclude ?? []).some(matches);
}

const rulesetEnforced = expectingKind("/settings/rules", async (ctx, out, expected) => {
  if (!expected.ruleset.expected) return out.pass("Not available for private repositories on GitHub Free");
  const summaries = await list(
    ctx.read,
    `/repos/${ctx.repo}/rulesets?includes_parents=true`,
    "the rulesets",
    "Administration read",
  );
  if ("unreadable" in summaries) return out.unknown(summaries.unreadable);
  const covering = [];
  for (const summary of summaries.items.filter(item => item.target === "branch")) {
    const { status, body } = await ctx.read.get(`/repos/${ctx.repo}/rulesets/${summary.id}`);
    if (status !== 200)
      return out.unknown(unreadable(`the ruleset \`${summary.name}\``, status, "Administration read"));
    if (coversDefaultBranch(body, ctx.live.default_branch)) covering.push(body);
  }
  if (covering.length === 0) return out.fail("No active ruleset protects the default branch");
  const active = covering.filter(ruleset => ruleset.enforcement === "active");
  if (active.length === 0) return out.fail(`The default branch ruleset is in \`${covering[0].enforcement}\` mode`);
  const actors = active.flatMap(ruleset => ruleset.bypass_actors ?? []);
  if (actors.length > 0) {
    const names = actors.map((/** @type {any} */ actor) => `${actor.actor_type}:${actor.actor_id}`);
    return out.fail(`The default branch ruleset has bypass actors: ${codes(names)}`);
  }
  return out.pass("The default branch ruleset is active with no bypass actors");
});

const visibility = kind("/settings", async (ctx, out) => {
  if (!ctx.expectedVisibility) return out.unknown("Expected visibility not set");
  if (ctx.live.visibility !== ctx.expectedVisibility) {
    return out.fail(`Expected ${ctx.expectedVisibility}, found ${ctx.live.visibility}`);
  }
  return out.pass(`The repository is ${ctx.live.visibility}`);
});

const collaborators = kind("/settings/access", async (ctx, out) => {
  const owners = new Set(ctx.owners.map(owner => owner.toLowerCase()));
  const base = `/repos/${ctx.repo}`;
  const [direct, teams, invitations] = await Promise.all([
    list(ctx.read, `${base}/collaborators?affiliation=direct`, "the collaborators", "Administration read"),
    list(ctx.read, `${base}/teams`, "the teams", "Administration read"),
    list(ctx.read, `${base}/invitations`, "the invitations", "Administration read"),
  ]);
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const unreadables = [];
  for (const [listing, describe] of /** @type {[Listing, (item: any) => string | null][]} */ ([
    [direct, item => (owners.has(String(item.login).toLowerCase()) ? null : `\`${item.login}\` is a collaborator`)],
    [teams, item => `team \`${item.slug}\` has access`],
    [invitations, item => `\`${item.invitee?.login}\` is invited`],
  ])) {
    if ("unreadable" in listing) unreadables.push(listing.unreadable);
    else problems.push(...listing.items.map(describe).filter(problem => problem !== null));
  }
  return settle(out, problems, unreadables, "Only the owners have access");
});

const deployKeys = kind("/settings/keys", async (ctx, out) => {
  const keys = await list(ctx.read, `/repos/${ctx.repo}/keys`, "the deploy keys", "Administration read");
  if ("unreadable" in keys) return out.unknown(keys.unreadable);
  if (keys.items.length === 0) return out.pass("No deploy keys");
  return out.fail(keys.items.map(key => `Deploy key \`${key.title}\` added`).join("; "));
});

/** @param {any} hook */
function hookHost(hook) {
  try {
    return new URL(hook.config?.url).hostname;
  } catch {
    return null;
  }
}

const webhooks = kind("/settings/hooks", async (ctx, out) => {
  const hooks = await list(ctx.read, `/repos/${ctx.repo}/hooks`, "the webhooks", "Webhooks read");
  if ("unreadable" in hooks) return out.unknown(hooks.unreadable);
  if (hooks.items.length === 0) return out.pass("No webhooks");
  return out.fail(
    hooks.items
      .map(hook => {
        const host = hookHost(hook);
        return host ? `Webhook to \`${host}\` added` : "Webhook with an unreadable address added";
      })
      .join("; "),
  );
});

const securityFeatures = expectingKind("/settings/security_analysis", async (ctx, out, expected) => {
  if (expected.securityFeatures.length === 0) return out.pass("No security features expected");
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const unreadables = [];
  for (const feature of expected.securityFeatures) {
    if (feature === "private_vulnerability_reporting") {
      const { status, body } = await ctx.read.get(`/repos/${ctx.repo}/private-vulnerability-reporting`);
      if (status !== 200) unreadables.push(unreadable(`\`${feature}\``, status, "Administration read"));
      else if (body?.enabled !== true) problems.push(`\`${feature}\` is off`);
    } else if (!ctx.live.security_and_analysis) {
      unreadables.push(unreadable(`\`${feature}\``, 403, "Administration read"));
    } else if (ctx.live.security_and_analysis[feature]?.status !== "enabled") {
      problems.push(`\`${feature}\` is off`);
    }
  }
  return settle(out, problems, unreadables, "Every expected security feature is on");
});

const actionsSettings = expectingKind("/settings/actions", async (ctx, out, expected) => {
  const { status, body } = await ctx.read.get(`/repos/${ctx.repo}/actions/permissions/workflow`);
  if (status !== 200) return out.unknown(unreadable("the workflow permissions", status, "Administration read"));
  /** @type {string[]} */
  const problems = [];
  for (const [key, want] of Object.entries(/** @type {Record<string, unknown>} */ (expected.actionsPermissions))) {
    if (body[key] === want) continue;
    problems.push(
      key === "default_workflow_permissions"
        ? `Default workflow permissions are \`${body[key]}\`, expected \`${want}\``
        : `\`${key}\` is \`${body[key]}\`, expected \`${want}\``,
    );
  }
  return settle(out, problems, [], "Workflow permissions match the standard");
});

const environments = expectingKind("/settings/environments", async (ctx, out, expected) => {
  const base = `/repos/${ctx.repo}`;
  const found = await list(ctx.read, `${base}/environments`, "the environments", "Administration read");
  if ("unreadable" in found) return out.unknown(found.unreadable);
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const unreadables = [];
  const names = new Set(found.items.map(environment => environment.name));
  for (const environment of found.items) {
    if (!expected.environments.some(wanted => wanted.name === environment.name)) {
      problems.push(`Unexpected environment \`${environment.name}\``);
    }
  }
  for (const wanted of expected.environments) {
    if (!names.has(wanted.name)) {
      problems.push(`Environment \`${wanted.name}\` is missing`);
      continue;
    }
    if (wanted.refs.length === 0) continue;
    const environment = found.items.find(item => item.name === wanted.name);
    if (environment.deployment_branch_policy?.custom_branch_policies !== true) {
      problems.push(`\`${wanted.name}\` can deploy from any ref, expected ${codes(wanted.refs)}`);
      continue;
    }
    const policies = await list(
      ctx.read,
      `${base}/environments/${encodeURIComponent(wanted.name)}/deployment-branch-policies`,
      `the deployment refs of \`${wanted.name}\``,
      "Administration read",
    );
    if ("unreadable" in policies) {
      unreadables.push(policies.unreadable);
      continue;
    }
    const actual = policies.items.map(policy => `${policy.type}:${policy.name}`);
    const extra = actual.filter(ref => !wanted.refs.includes(ref));
    const missing = wanted.refs.filter(ref => !actual.includes(ref));
    if (extra.length > 0) {
      problems.push(`\`${wanted.name}\` deploys from ${codes(extra)}, expected ${codes(wanted.refs)}`);
    } else if (missing.length > 0) {
      problems.push(`\`${wanted.name}\` doesn't deploy from ${codes(missing)}`);
    }
  }
  return settle(out, problems, unreadables, "Environments and their deployment refs match the standard");
});

const secretsKnown = expectingKind("/settings/secrets/actions", async (ctx, out, expected) => {
  const base = `/repos/${ctx.repo}`;
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const unreadables = [];
  /**
   * @param {Listing} listing
   * @param {string[]} allowed
   * @param {string} scope
   */
  const review = (listing, allowed, scope) => {
    if ("unreadable" in listing) {
      unreadables.push(listing.unreadable);
      return;
    }
    for (const { name } of listing.items) {
      if (!allowed.includes(name) && ctx.exempt(name) === null) {
        problems.push(`Unexpected secret \`${name}\` in \`${scope}\``);
      }
    }
  };
  review(
    await list(ctx.read, `${base}/actions/secrets`, "the secrets", "Secrets read"),
    expected.repositorySecrets,
    "repository",
  );
  const found = await list(ctx.read, `${base}/environments`, "the environments", "Administration read");
  if ("unreadable" in found) unreadables.push(found.unreadable);
  else {
    for (const { name } of found.items) {
      review(
        await list(
          ctx.read,
          `${base}/environments/${encodeURIComponent(name)}/secrets`,
          `the secrets of \`${name}\``,
          "Secrets read",
        ),
        expected.environmentSecrets[name] ?? [],
        name,
      );
    }
  }
  return settle(out, problems, unreadables, "Every secret is expected");
});

/**
 * @param {import("./expected.js").AcceptedRecord} accepted
 * @param {import("./expected.js").AcceptedRecord} live
 */
function describeChange(accepted, live) {
  const added = live.modules.filter(module => !accepted.modules.includes(module));
  const removed = accepted.modules.filter(module => !live.modules.includes(module));
  const moduleChange = [
    added.length > 0 ? `+${added.join(", +")}` : "",
    removed.length > 0 ? `−${removed.join(", −")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const flags = [...new Set([...Object.keys(accepted.flags), ...Object.keys(live.flags)])]
    .sort()
    .filter(flag => Boolean(accepted.flags[flag]) !== Boolean(live.flags[flag]))
    .map(flag => `${flag}: ${Boolean(accepted.flags[flag])} → ${Boolean(live.flags[flag])}`);
  const parts = [moduleChange ? `modules ${moduleChange}` : "", ...flags].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "modules and flags unchanged";
}

const recordAccepted = kind(`/blob/HEAD/${RECORD_PATH}`, async (ctx, out) => {
  const { liveRecord, acceptedSha } = ctx;
  if (!liveRecord) {
    return out.fail(
      acceptedSha ? `\`${RECORD_PATH}\` was removed after it was accepted` : `\`${RECORD_PATH}\` is missing`,
    );
  }
  if (!acceptedSha) return out.fail("Not accepted yet");
  if (liveRecord.sha === acceptedSha) return out.pass("The record is the accepted one");
  /** @type {import("./expected.js").AcceptedRecord} */
  let accepted;
  try {
    const text = await ctx.read.blob(ctx.repo, acceptedSha);
    if (text === null) return out.fail("The accepted record can't be read");
    accepted = parseRecord(text);
  } catch {
    return out.fail("The accepted record can't be read");
  }
  try {
    return out.fail(`\`${RECORD_PATH}\` changed: ${describeChange(accepted, parseRecord(liveRecord.text))}`);
  } catch {
    return out.fail(`\`${RECORD_PATH}\` changed and can't be read`);
  }
});

/** @type {Record<string, (ctx: RepoContext) => Promise<Result>>} */
export const REPOSITORY_KINDS = {
  "ruleset-enforced": rulesetEnforced,
  visibility,
  "collaborators-owners-only": collaborators,
  "deploy-keys-none": deployKeys,
  "webhooks-none": webhooks,
  "security-features": securityFeatures,
  "actions-permissions-match": actionsSettings,
  "environments-match": environments,
  "secrets-known": secretsKnown,
  "record-accepted": recordAccepted,
};
