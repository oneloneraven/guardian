import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { checkOrganisation, checkRepository, sweep } from "../src/checks/run.js";
import { GithubUnavailable } from "../src/github/app.js";

const O = "oneloneraven";
const RECORD = JSON.stringify({
  version: 1,
  modules: ["core"],
  visibility: "public",
  flags: {},
  skipped: {},
  exceptions: [],
});

const security = (/** @type {string} */ id, /** @type {string} */ kind, scope = "repository") => ({
  group: "security",
  id,
  kind,
  scope,
  modules: [],
  title: id,
});

const standard = {
  bootstrap: "v9.9.9",
  version: 2,
  checks: [
    security("visibility", "visibility"),
    security("deploy-keys", "deploy-keys-none"),
    security("environments", "environments-match"),
    security("mystery", "no-such-kind"),
    { group: "conformance", id: "labels", kind: "labels-match", modules: ["core"], title: "Labels" },
    security("org-2fa", "org-2fa", "organisation"),
    security("org-apps", "org-apps", "organisation"),
  ],
  expected: {
    environments: {},
    secrets: {},
    apps: {},
    securityFeatures: { public: [], private: [] },
    actionsPermissions: {},
    ruleset: { name: "default-branch-protection" },
  },
  organisation: { apps: [{ slug: "{owner}-board-sync" }], secrets: [], settings: {} },
};

/** @param {string} text */
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function pinStandard() {
  const body = JSON.stringify(standard);
  const sha = await sha256(body);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO standard (version, sha256, body, verified_at) VALUES ('v9.9.9', ?1, ?2, 'now')").bind(
      sha,
      body,
    ),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('standard', ?1)").bind(
      JSON.stringify({ version: "v9.9.9", sha256: sha }),
    ),
  ]);
}

/**
 * @param {Record<string, { status: number, body?: any }>} routes
 * @param {{ files?: Record<string, { text: string, sha: string }>, blobs?: Record<string, string> }} [extra]
 */
function fakeReader(routes, { files = {}, blobs = {} } = {}) {
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
    /** @param {string} repo */
    async file(repo) {
      return files[repo] ?? null;
    },
    /** @param {string} _repo @param {string} sha */
    async blob(_repo, sha) {
      return blobs[sha] ?? null;
    },
  };
}

/** @param {any} body */
const ok = body => ({ status: 200, body });

const routes = (/** @type {string[]} */ names = ["guardian"]) => ({
  "/installation/repositories": ok({ total_count: names.length, repositories: names.map(name => ({ name })) }),
  [`/orgs/${O}`]: ok({ plan: { name: "Free" }, two_factor_requirement_enabled: true }),
  [`/orgs/${O}/installations`]: ok({ installations: [{ app_slug: "oneloneraven-board-sync" }] }),
  ...Object.fromEntries(
    names.flatMap(name => [
      [`/repos/${O}/${name}`, ok({ visibility: "public", default_branch: "main" })],
      [`/repos/${O}/${name}/keys`, ok([])],
      [`/repos/${O}/${name}/environments`, ok({ environments: [] })],
    ]),
  ),
});

const stored = async () =>
  Object.fromEntries(
    (await env.DB.prepare("SELECT target, check_id, status, reason FROM results").all()).results.map(row => [
      `${row.target}/${row.check_id}`,
      { status: row.status, reason: row.reason },
    ]),
  );

beforeEach(async () => {
  await env.DB.batch(
    ["results", "security_events", "standard", "settings", "repositories", "exceptions"].map(table =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

test("sweep checks the organisation and every installed repository, recording a skipped result for an exception", async () => {
  await pinStandard();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO repositories (name, expected_visibility) VALUES ('guardian', 'public')"),
    env.DB.prepare(
      "INSERT INTO exceptions (target, check_id, reason) VALUES ('guardian', 'deploy-keys', 'A deploy key for the build box')",
    ),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('apps', '[]')"),
  ]);
  const outcome = await sweep(env, "sweep", { readerFor: async () => fakeReader(routes()) });
  expect(outcome).toEqual({ checked: 7, unknown: null });
  const results = await stored();
  expect(results["guardian/visibility"].status).toBe("pass");
  expect(results["guardian/deploy-keys"]).toEqual({ status: "skipped", reason: "A deploy key for the build box" });
  expect(results["guardian/environments"].status).toBe("pass");
  expect(results["guardian/record-accepted"]).toEqual({
    status: "fail",
    reason: "`.bootstrap/record.json` is missing",
  });
  expect(results["organisation/org-2fa"].status).toBe("pass");
  expect(results["organisation/org-apps"].status).toBe("pass");
  expect(results["guardian/labels"]).toBeUndefined();
});

test("an unknown kind is Unknown naming the kind", async () => {
  await pinStandard();
  const transitions = await checkRepository(env, fakeReader(routes()), "guardian", "sweep");
  expect(transitions.find(transition => transition.check === "mystery")).toMatchObject({
    status: "unknown",
    reason: "Guardian doesn't know the check kind `no-such-kind`",
  });
});

test('with no standard pinned every result is Unknown "No standard pinned"', async () => {
  const outcome = await sweep(env, "sweep", { readerFor: async () => fakeReader(routes()) });
  expect(outcome.unknown).toBe("No standard pinned");
  const results = Object.values(await stored());
  expect(results.length).toBeGreaterThan(0);
  for (const result of results) expect(result).toEqual({ status: "unknown", reason: "No standard pinned" });
});

test("a repository GitHub lists that Guardian hasn't seen is added with no expected visibility", async () => {
  await pinStandard();
  await sweep(env, "sweep", { readerFor: async () => fakeReader(routes(["newcomer"])) });
  const row = await env.DB.prepare("SELECT * FROM repositories WHERE name = 'newcomer'").first();
  expect(row).toEqual({ name: "newcomer", expected_visibility: null, accepted_record_sha: null });
  expect((await stored())["newcomer/visibility"]).toEqual({
    status: "unknown",
    reason: "Expected visibility not set",
  });
});

test("with no expected visibility, security-features and ruleset-enforced are Unknown, and environments still run", async () => {
  const withKinds = {
    ...standard,
    checks: [...standard.checks, security("features", "security-features"), security("ruleset", "ruleset-enforced")],
  };
  const body = JSON.stringify(withKinds);
  const sha = await sha256(body);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO standard (version, sha256, body, verified_at) VALUES ('v9.9.9', ?1, ?2, 'now')").bind(
      sha,
      body,
    ),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('standard', ?1)").bind(
      JSON.stringify({ version: "v9.9.9", sha256: sha }),
    ),
  ]);
  const transitions = await checkRepository(env, fakeReader(routes()), "guardian", "sweep");
  const by = Object.fromEntries(transitions.map(transition => [transition.check, transition]));
  for (const id of ["features", "ruleset", "visibility"]) {
    expect(by[id], id).toMatchObject({ status: "unknown", reason: "Expected visibility not set" });
  }
  expect(by.environments.status).toBe("pass");
});

test("an unreadable accepted record makes the checks that need expectations Unknown", async () => {
  await pinStandard();
  await env.DB.prepare(
    "INSERT INTO repositories (name, expected_visibility, accepted_record_sha) VALUES ('guardian', 'public', 'gone')",
  ).run();
  const read = fakeReader(routes(), { files: { [`${O}/guardian`]: { text: RECORD, sha: "live" } } });
  const transitions = await checkRepository(env, read, "guardian", "sweep");
  const by = Object.fromEntries(transitions.map(transition => [transition.check, transition]));
  expect(by.environments).toMatchObject({ status: "unknown", reason: "The accepted record can't be read" });
  expect(by["record-accepted"]).toMatchObject({ status: "fail", reason: "The accepted record can't be read" });
  expect(by.visibility.status).toBe("pass");
});

test("an accepted record gives the expectations its modules imply", async () => {
  await pinStandard();
  await env.DB.prepare(
    "INSERT INTO repositories (name, expected_visibility, accepted_record_sha) VALUES ('guardian', 'public', 'acc')",
  ).run();
  const read = fakeReader(routes(), {
    files: { [`${O}/guardian`]: { text: RECORD, sha: "acc" } },
    blobs: { acc: RECORD },
  });
  const transitions = await checkRepository(env, read, "guardian", "sweep");
  const by = Object.fromEntries(transitions.map(transition => [transition.check, transition]));
  expect(by.environments.status).toBe("pass");
  expect(by["record-accepted"].status).toBe("pass");
});

test("the organisation allows a release App for a repository whose accepted modules include core", async () => {
  await pinStandard();
  await env.DB.prepare("INSERT INTO repositories (name, accepted_record_sha) VALUES ('guardian', 'acc')").run();
  const read = fakeReader(
    { ...routes(), [`/orgs/${O}/installations`]: ok({ installations: [{ app_slug: "guardian-release" }] }) },
    { blobs: { acc: RECORD } },
  );
  const transitions = await checkOrganisation(env, read, "sweep");
  expect(transitions.find(transition => transition.check === "org-apps")?.status).toBe("pass");
});

test("when GitHub is unavailable every known check is Unknown naming why", async () => {
  await pinStandard();
  await env.DB.prepare("INSERT INTO repositories (name) VALUES ('guardian')").run();
  const outcome = await sweep(env, "sweep", {
    readerFor: async () => {
      throw new GithubUnavailable("github-app-not-configured");
    },
  });
  const reason = "Guardian can't reach GitHub: github-app-not-configured";
  expect(outcome).toEqual({ checked: 7, unknown: reason });
  const results = await stored();
  expect(Object.keys(results).sort()).toEqual(
    [
      "guardian/deploy-keys",
      "guardian/environments",
      "guardian/mystery",
      "guardian/record-accepted",
      "guardian/visibility",
      "organisation/org-2fa",
      "organisation/org-apps",
    ].sort(),
  );
  for (const result of Object.values(results)) expect(result).toEqual({ status: "unknown", reason });
});
