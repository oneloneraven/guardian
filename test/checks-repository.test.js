import { expect, test } from "vitest";
import { expectedFor, parseRecord } from "../src/checks/expected.js";
import { REPOSITORY_KINDS } from "../src/checks/repository.js";
import { ReadError } from "../src/github/reader.js";
import recordGuardian from "./fixtures/record-guardian.json?raw";
import standardText from "./fixtures/standard-v1.18.0.json?raw";

const R = "oneloneraven/guardian";
const BASE = `https://github.com/${R}`;
const standard = JSON.parse(standardText);
const expected = expectedFor({
  standard,
  record: parseRecord(recordGuardian),
  repo: "guardian",
  owner: "oneloneraven",
  visibility: "public",
  plan: "free",
});

/**
 * @param {Record<string, { status: number, body?: any }>} routes
 * @param {Record<string, string | Error>} [blobs]
 */
function stubReader(routes, blobs = {}) {
  /** @param {string} path */
  const lookup = path => {
    const route = routes[path.replace(/[?&]per_page=100/, "")];
    if (!route) throw new Error(`unstubbed ${path}`);
    return route;
  };
  return {
    /** @param {string} path */
    async get(path) {
      const route = lookup(path);
      return { status: route.status, body: route.status === 200 ? route.body : null };
    },
    /** @param {string} path */
    async all(path) {
      const route = lookup(path);
      const body = route.body ?? [];
      const items = Array.isArray(body) ? body : (Object.values(body).find(Array.isArray) ?? []);
      return { status: route.status, items: route.status === 200 ? items : [] };
    },
    async file() {
      throw new Error("unused");
    },
    /** @param {string} _repo @param {string} sha */
    async blob(_repo, sha) {
      const blob = blobs[sha];
      if (blob instanceof Error) throw blob;
      return blob ?? null;
    },
  };
}

/** @param {any} body */
const ok = body => ({ status: 200, body });

/** @param {Partial<Parameters<(typeof REPOSITORY_KINDS)[string]>[0]>} [overrides] */
function context(overrides = {}) {
  return {
    read: stubReader({}),
    repo: R,
    live: { visibility: "public", default_branch: "main", security_and_analysis: {} },
    expected,
    owners: ["raven"],
    expectedVisibility: /** @type {"public"} */ ("public"),
    acceptedSha: null,
    liveRecord: null,
    exempt: () => null,
    ...overrides,
  };
}

const rulesetList = ok([{ id: 7, name: "default-branch-protection", target: "branch", enforcement: "active" }]);
/** @param {Record<string, any>} [changes] */
const rulesetDetail = (changes = {}) =>
  ok({
    id: 7,
    name: "default-branch-protection",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    ...changes,
  });

test("ruleset-enforced passes with an active ruleset and no bypass actors", async () => {
  const read = stubReader({
    [`/repos/${R}/rulesets?includes_parents=true`]: rulesetList,
    [`/repos/${R}/rulesets/7`]: rulesetDetail(),
  });
  const result = await REPOSITORY_KINDS["ruleset-enforced"](context({ read }));
  expect(result).toMatchObject({ status: "pass", link: `${BASE}/settings/rules` });
});

test("ruleset-enforced fails on bypass actors, evaluate mode and no ruleset", async () => {
  const run = async (/** @type {any} */ list, /** @type {any} */ detail) =>
    REPOSITORY_KINDS["ruleset-enforced"](
      context({
        read: stubReader({
          [`/repos/${R}/rulesets?includes_parents=true`]: list,
          [`/repos/${R}/rulesets/7`]: detail,
        }),
      }),
    );
  const bypass = await run(
    rulesetList,
    rulesetDetail({ bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }] }),
  );
  expect(bypass).toMatchObject({
    status: "fail",
    reason: "The default branch ruleset has bypass actors: `RepositoryRole:5`",
  });
  const evaluate = await run(rulesetList, rulesetDetail({ enforcement: "evaluate" }));
  expect(evaluate).toMatchObject({ status: "fail", reason: "The default branch ruleset is in `evaluate` mode" });
  const none = await run(ok([]), ok({}));
  expect(none).toMatchObject({ status: "fail", reason: "No active ruleset protects the default branch" });
});

test("ruleset-enforced passes without reading when it isn't expected", async () => {
  const unexpected = { ...expected, ruleset: { ...expected.ruleset, expected: false } };
  const result = await REPOSITORY_KINDS["ruleset-enforced"](context({ expected: unexpected }));
  expect(result).toMatchObject({
    status: "pass",
    reason: "Not available for private repositories on GitHub Free",
  });
});

test("visibility passes when it matches and fails when it doesn't", async () => {
  expect(await REPOSITORY_KINDS.visibility(context())).toMatchObject({ status: "pass", link: `${BASE}/settings` });
  const fail = await REPOSITORY_KINDS.visibility(context({ live: { visibility: "private" } }));
  expect(fail).toMatchObject({ status: "fail", reason: "Expected public, found private" });
});

test("visibility is Unknown when the settings hold no expectation", async () => {
  const result = await REPOSITORY_KINDS.visibility(context({ expectedVisibility: null }));
  expect(result).toMatchObject({ status: "unknown", reason: "Expected visibility not set" });
});

/** @param {any[]} direct @param {any[]} teams @param {any[]} invitations */
const accessRoutes = (direct, teams, invitations) => ({
  [`/repos/${R}/collaborators?affiliation=direct`]: ok(direct),
  [`/repos/${R}/teams`]: ok(teams),
  [`/repos/${R}/invitations`]: ok(invitations),
});

test("collaborators passes for owners only", async () => {
  const read = stubReader(accessRoutes([{ login: "Raven" }], [], []));
  expect(await REPOSITORY_KINDS["collaborators-owners-only"](context({ read }))).toMatchObject({
    status: "pass",
    link: `${BASE}/settings/access`,
  });
});

test("collaborators fails naming each collaborator, team and invitation", async () => {
  const read = stubReader(accessRoutes([{ login: "mallory" }], [{ slug: "staff" }], [{ invitee: { login: "eve" } }]));
  const result = await REPOSITORY_KINDS["collaborators-owners-only"](context({ read }));
  expect(result.status).toBe("fail");
  expect(result.reason).toContain("`mallory` is a collaborator");
  expect(result.reason).toContain("team `staff` has access");
  expect(result.reason).toContain("`eve` is invited");
});

test("deploy-keys passes with none and fails naming the key", async () => {
  const pass = await REPOSITORY_KINDS["deploy-keys-none"](
    context({ read: stubReader({ [`/repos/${R}/keys`]: ok([]) }) }),
  );
  expect(pass).toMatchObject({ status: "pass", link: `${BASE}/settings/keys` });
  const fail = await REPOSITORY_KINDS["deploy-keys-none"](
    context({ read: stubReader({ [`/repos/${R}/keys`]: ok([{ title: "ci box" }]) }) }),
  );
  expect(fail).toMatchObject({ status: "fail", reason: "Deploy key `ci box` added" });
});

test("webhooks passes with none", async () => {
  const result = await REPOSITORY_KINDS["webhooks-none"](
    context({ read: stubReader({ [`/repos/${R}/hooks`]: ok([]) }) }),
  );
  expect(result).toMatchObject({ status: "pass", link: `${BASE}/settings/hooks` });
});

test("webhooks names the host, never the path or query", async () => {
  const url = "https://hooks.example.test/services/T000/B000/secret-token?key=abc123";
  const result = await REPOSITORY_KINDS["webhooks-none"](
    context({ read: stubReader({ [`/repos/${R}/hooks`]: ok([{ config: { url } }]) }) }),
  );
  expect(result).toMatchObject({ status: "fail", reason: "Webhook to `hooks.example.test` added" });
  expect(result.reason).not.toContain("secret-token");
  expect(result.reason).not.toContain("abc123");
});

const featureRoutes = { [`/repos/${R}/private-vulnerability-reporting`]: ok({ enabled: true }) };
const allOn = {
  secret_scanning: { status: "enabled" },
  secret_scanning_push_protection: { status: "enabled" },
  dependabot_security_updates: { status: "enabled" },
};

test("security-features passes when every listed feature is on, and ignores extras", async () => {
  const live = { security_and_analysis: { ...allOn, secret_scanning_non_provider_patterns: { status: "disabled" } } };
  const result = await REPOSITORY_KINDS["security-features"](context({ live, read: stubReader(featureRoutes) }));
  expect(result).toMatchObject({ status: "pass", link: `${BASE}/settings/security_analysis` });
});

test("security-features fails naming each feature that is off", async () => {
  const live = {
    security_and_analysis: { ...allOn, secret_scanning_push_protection: { status: "disabled" } },
  };
  const read = stubReader({ [`/repos/${R}/private-vulnerability-reporting`]: ok({ enabled: false }) });
  const result = await REPOSITORY_KINDS["security-features"](context({ live, read }));
  expect(result.status).toBe("fail");
  expect(result.reason).toContain("`secret_scanning_push_protection` is off");
  expect(result.reason).toContain("`private_vulnerability_reporting` is off");
});

test("actions-settings passes when the workflow permissions match", async () => {
  const read = stubReader({
    [`/repos/${R}/actions/permissions/workflow`]: ok({
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    }),
  });
  expect(await REPOSITORY_KINDS["actions-permissions-match"](context({ read }))).toMatchObject({
    status: "pass",
    link: `${BASE}/settings/actions`,
  });
});

test("actions-settings fails naming the permission found and expected", async () => {
  const read = stubReader({
    [`/repos/${R}/actions/permissions/workflow`]: ok({
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: false,
    }),
  });
  expect(await REPOSITORY_KINDS["actions-permissions-match"](context({ read }))).toMatchObject({
    status: "fail",
    reason: "Default workflow permissions are `write`, expected `read`",
  });
});

/** @param {Record<string, string[]>} [policies] */
function environmentRoutes(policies = {}) {
  const refs = {
    infra: [["branch", "main"]],
    production: [
      ["branch", "main"],
      ["tag", "v*"],
    ],
    ...Object.fromEntries(Object.entries(policies).map(([name, list]) => [name, list.map(ref => ref.split(":"))])),
  };
  /** @type {Record<string, { status: number, body?: any }>} */
  const routes = {
    [`/repos/${R}/environments`]: ok({
      total_count: Object.keys(refs).length,
      environments: Object.keys(refs).map(name => ({
        name,
        deployment_branch_policy: { custom_branch_policies: true },
      })),
    }),
  };
  for (const [name, list] of Object.entries(refs)) {
    routes[`/repos/${R}/environments/${name}/deployment-branch-policies`] = ok({
      total_count: list.length,
      branch_policies: list.map(([type, ref]) => ({ type, name: ref })),
    });
  }
  return routes;
}

test("environments passes when names and deployment refs match", async () => {
  const read = stubReader(environmentRoutes());
  expect(await REPOSITORY_KINDS["environments-match"](context({ read }))).toMatchObject({
    status: "pass",
    link: `${BASE}/settings/environments`,
  });
});

test("environments fails on an unexpected environment and on a wrong deployment ref", async () => {
  const unexpected = await REPOSITORY_KINDS["environments-match"](
    context({ read: stubReader(environmentRoutes({ staging: ["branch:main"] })) }),
  );
  expect(unexpected).toMatchObject({ status: "fail", reason: "Unexpected environment `staging`" });
  const wrong = await REPOSITORY_KINDS["environments-match"](
    context({ read: stubReader(environmentRoutes({ production: ["branch:dev", "tag:v*"] })) }),
  );
  expect(wrong).toMatchObject({
    status: "fail",
    reason: "`production` deploys from `branch:dev`, expected `branch:main`, `tag:v*`",
  });
});

/** @param {Record<string, string[]>} [environmentSecrets] @param {string[]} [repositorySecrets] */
function secretRoutes(environmentSecrets = {}, repositorySecrets = expected.repositorySecrets) {
  const perEnvironment = { ...expected.environmentSecrets, ...environmentSecrets };
  /** @type {Record<string, { status: number, body?: any }>} */
  const routes = {
    ...environmentRoutes(),
    [`/repos/${R}/actions/secrets`]: ok({ total_count: 1, secrets: repositorySecrets.map(name => ({ name })) }),
  };
  for (const [name, list] of Object.entries(perEnvironment)) {
    routes[`/repos/${R}/environments/${name}/secrets`] = ok({ secrets: list.map(secret => ({ name: secret })) });
  }
  return routes;
}

test("secrets-known passes when every secret is expected", async () => {
  expect(await REPOSITORY_KINDS["secrets-known"](context({ read: stubReader(secretRoutes()) }))).toMatchObject({
    status: "pass",
    link: `${BASE}/settings/secrets/actions`,
  });
});

test("secrets-known fails naming the secret and its scope", async () => {
  const read = stubReader(
    secretRoutes({ production: [...expected.environmentSecrets.production, "STRAY"] }, [
      ...expected.repositorySecrets,
      "LOOSE",
    ]),
  );
  const result = await REPOSITORY_KINDS["secrets-known"](context({ read }));
  expect(result.status).toBe("fail");
  expect(result.reason).toContain("Unexpected secret `LOOSE` in `repository`");
  expect(result.reason).toContain("Unexpected secret `STRAY` in `production`");
});

test("a secret named in an exception's match is allowed", async () => {
  const read = stubReader(secretRoutes({}, [...expected.repositorySecrets, "LEGACY_TOKEN"]));
  const exempt = (/** @type {string} */ match) => (match === "LEGACY_TOKEN" ? "Retired in December" : null);
  const result = await REPOSITORY_KINDS["secrets-known"](context({ read, exempt }));
  expect(result.status).toBe("pass");
});

test('a 403 on environment secrets makes secrets-known Unknown naming "Environments read" and leaves environments Pass', async () => {
  const routes = { ...secretRoutes(), [`/repos/${R}/environments/production/secrets`]: { status: 403 } };
  const read = stubReader(routes);
  const secrets = await REPOSITORY_KINDS["secrets-known"](context({ read }));
  expect(secrets.status).toBe("unknown");
  expect(secrets.reason).toContain("Environments read");
  expect((await REPOSITORY_KINDS["environments-match"](context({ read }))).status).toBe("pass");
});

test("a failing endpoint is Unknown with its status, and never a pass", async () => {
  const server = await REPOSITORY_KINDS["deploy-keys-none"](
    context({ read: stubReader({ [`/repos/${R}/keys`]: { status: 502 } }) }),
  );
  expect(server).toMatchObject({ status: "unknown", reason: "Couldn't read the deploy keys (HTTP 502)" });
  const timeout = await REPOSITORY_KINDS["deploy-keys-none"](
    context({ read: stubReader({ [`/repos/${R}/keys`]: { status: 0 } }) }),
  );
  expect(timeout).toMatchObject({ status: "unknown", reason: "Couldn't read the deploy keys (no answer)" });
});

test("kinds that need expectations are Unknown with the reason when there are none", async () => {
  const unknown = { unknown: "The accepted record can't be read" };
  for (const kind of [
    "ruleset-enforced",
    "security-features",
    "actions-permissions-match",
    "environments-match",
    "secrets-known",
  ]) {
    const result = await REPOSITORY_KINDS[kind](context({ expected: unknown }));
    expect(result, kind).toMatchObject({ status: "unknown", reason: "The accepted record can't be read" });
  }
});

const record = (/** @type {object} */ changes) =>
  JSON.stringify({
    version: 1,
    modules: ["core"],
    visibility: "public",
    flags: {},
    skipped: {},
    exceptions: [],
    ...changes,
  });

test("record-accepted passes when the live record is the accepted one", async () => {
  const result = await REPOSITORY_KINDS["record-accepted"](
    context({ acceptedSha: "aaa", liveRecord: { sha: "aaa", text: record({}) } }),
  );
  expect(result).toMatchObject({ status: "pass", link: `${BASE}/blob/HEAD/.bootstrap/record.json` });
});

test("record-accepted fails with the modules and flags that changed", async () => {
  const accepted = record({ modules: ["core", "web-app"], flags: { beta: false, admin: true } });
  const live = record({ modules: ["core", "js-toolchain"], flags: { beta: true, admin: true } });
  const result = await REPOSITORY_KINDS["record-accepted"](
    context({ acceptedSha: "aaa", liveRecord: { sha: "bbb", text: live }, read: stubReader({}, { aaa: accepted }) }),
  );
  expect(result).toMatchObject({
    status: "fail",
    reason: "`.bootstrap/record.json` changed: modules +js-toolchain −web-app, beta: false → true",
  });
});

test("record-accepted fails with Not accepted yet when nothing has been accepted", async () => {
  const result = await REPOSITORY_KINDS["record-accepted"](context({ liveRecord: { sha: "bbb", text: record({}) } }));
  expect(result).toMatchObject({ status: "fail", reason: "Not accepted yet" });
});

test('record-accepted is Fail with "The accepted record can\'t be read" when the blob is 404, and expectations needing it are Unknown', async () => {
  const accepted = context({
    acceptedSha: "aaa",
    liveRecord: { sha: "bbb", text: record({}) },
    read: stubReader({}, {}),
  });
  expect(await REPOSITORY_KINDS["record-accepted"](accepted)).toMatchObject({
    status: "fail",
    reason: "The accepted record can't be read",
  });
  const thrown = context({
    acceptedSha: "aaa",
    liveRecord: { sha: "bbb", text: record({}) },
    read: stubReader({}, { aaa: new ReadError("aaa", 500) }),
  });
  expect(await REPOSITORY_KINDS["record-accepted"](thrown)).toMatchObject({
    status: "fail",
    reason: "The accepted record can't be read",
  });
  const needing = await REPOSITORY_KINDS["secrets-known"](
    context({ expected: { unknown: "The accepted record can't be read" } }),
  );
  expect(needing).toMatchObject({ status: "unknown", reason: "The accepted record can't be read" });
});

test("record-accepted fails when there is no record at all", async () => {
  const result = await REPOSITORY_KINDS["record-accepted"](context());
  expect(result).toMatchObject({ status: "fail", reason: "`.bootstrap/record.json` is missing" });
});
