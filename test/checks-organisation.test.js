import { expect, test } from "vitest";
import { ORGANISATION_KINDS } from "../src/checks/organisation.js";
import standardText from "./fixtures/standard-v1.18.0.json?raw";

const O = "oneloneraven";
const BASE = `https://github.com/orgs/${O}`;
const standard = JSON.parse(standardText);

/** @param {Record<string, { status: number, body?: any }>} routes */
function stubReader(routes) {
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
    async blob() {
      throw new Error("unused");
    },
  };
}

/** @param {any} body */
const ok = body => ({ status: 200, body });

const goodLive = {
  default_repository_permission: "read",
  members_can_create_repositories: false,
  members_can_fork_private_repositories: false,
  two_factor_requirement_enabled: true,
};

/** @param {Partial<Parameters<(typeof ORGANISATION_KINDS)[string]>[0]>} [overrides] */
function context(overrides = {}) {
  return {
    read: stubReader({}),
    org: O,
    live: goodLive,
    standard,
    owners: ["raven"],
    apps: [],
    repositories: [{ name: "guardian", modules: ["core"] }],
    exempt: () => null,
    ...overrides,
  };
}

/** @param {any[]} all @param {any[]} admins @param {any[]} invitations */
const memberRoutes = (all, admins, invitations) => ({
  [`/orgs/${O}/members?role=all`]: ok(all),
  [`/orgs/${O}/members?role=admin`]: ok(admins),
  [`/orgs/${O}/invitations`]: ok(invitations),
});

test("org-members passes when the owners are the only members, all admins, with no invitations", async () => {
  const read = stubReader(memberRoutes([{ login: "Raven" }], [{ login: "raven" }], []));
  expect(await ORGANISATION_KINDS["org-members"](context({ read }))).toMatchObject({
    status: "pass",
    link: `${BASE}/people`,
  });
});

test("org-members fails naming a member who isn't an owner", async () => {
  const read = stubReader(memberRoutes([{ login: "raven" }, { login: "mallory" }], [{ login: "raven" }], []));
  expect(await ORGANISATION_KINDS["org-members"](context({ read }))).toMatchObject({
    status: "fail",
    reason: "`mallory` is a member but not an owner",
  });
});

test("org-members fails naming an owner who isn't an admin of the organisation", async () => {
  const read = stubReader(memberRoutes([{ login: "raven" }], [], []));
  expect(await ORGANISATION_KINDS["org-members"](context({ read }))).toMatchObject({
    status: "fail",
    reason: "`raven` isn't an owner of the organisation",
  });
});

test("org-members fails naming a pending invitation's login", async () => {
  const read = stubReader(memberRoutes([{ login: "raven" }], [{ login: "raven" }], [{ login: "eve", email: null }]));
  expect(await ORGANISATION_KINDS["org-members"](context({ read }))).toMatchObject({
    status: "fail",
    reason: "`eve` is invited",
  });
});

test("org-members never names the email address of an email invitation", async () => {
  const read = stubReader(
    memberRoutes([{ login: "raven" }], [{ login: "raven" }], [{ login: null, email: "someone@example.test" }]),
  );
  const result = await ORGANISATION_KINDS["org-members"](context({ read }));
  expect(result).toMatchObject({ status: "fail", reason: "An email invitation is pending" });
  expect(result.reason).not.toContain("example.test");
});

test("org-members is Unknown naming Members read on a 403", async () => {
  const read = stubReader({
    ...memberRoutes([{ login: "raven" }], [{ login: "raven" }], []),
    [`/orgs/${O}/invitations`]: { status: 403 },
  });
  const result = await ORGANISATION_KINDS["org-members"](context({ read }));
  expect(result.status).toBe("unknown");
  expect(result.reason).toContain("Members read");
});

test("org-2fa passes when two-factor is required", async () => {
  expect(await ORGANISATION_KINDS["org-2fa"](context())).toMatchObject({
    status: "pass",
    reason: "Two-factor is required. GitHub's API doesn't show whether only secure methods are allowed.",
    link: `${BASE}/settings/security`,
  });
});

test("org-2fa fails when two-factor isn't required and is Unknown when GitHub doesn't say", async () => {
  const off = await ORGANISATION_KINDS["org-2fa"](context({ live: { two_factor_requirement_enabled: false } }));
  expect(off).toMatchObject({ status: "fail", reason: "Two-factor isn't required" });
  const hidden = await ORGANISATION_KINDS["org-2fa"](context({ live: {} }));
  expect(hidden).toMatchObject({ status: "unknown", reason: "GitHub didn't show whether two-factor is required" });
});

/** @param {string[]} slugs */
const installations = slugs => ({
  [`/orgs/${O}/installations`]: ok({ total_count: slugs.length, installations: slugs.map(app_slug => ({ app_slug })) }),
});

test("org-apps passes for the board-sync App, release Apps of core repositories and settings Apps", async () => {
  const read = stubReader(installations(["oneloneraven-board-sync", "Guardian-Release", "extra-app"]));
  expect(await ORGANISATION_KINDS["org-apps"](context({ read, apps: ["extra-app"] }))).toMatchObject({
    status: "pass",
    link: `${BASE}/settings/installations`,
  });
});

test("org-apps fails naming an App nobody expects", async () => {
  const read = stubReader(installations(["oneloneraven-board-sync", "sketchy-app"]));
  expect(await ORGANISATION_KINDS["org-apps"](context({ read }))).toMatchObject({
    status: "fail",
    reason: "App `sketchy-app` is installed",
  });
});

test("org-apps allows guardian-release only while guardian's accepted modules include core", async () => {
  const read = stubReader(installations(["guardian-release"]));
  const withCore = await ORGANISATION_KINDS["org-apps"](context({ read }));
  expect(withCore.status).toBe("pass");
  const without = await ORGANISATION_KINDS["org-apps"](
    context({ read, repositories: [{ name: "guardian", modules: [] }] }),
  );
  expect(without).toMatchObject({ status: "fail", reason: "App `guardian-release` is installed" });
});

test("org-webhooks passes with none and names only the host otherwise", async () => {
  const pass = await ORGANISATION_KINDS["org-webhooks-none"](
    context({ read: stubReader({ [`/orgs/${O}/hooks`]: ok([]) }) }),
  );
  expect(pass).toMatchObject({ status: "pass", link: `${BASE}/settings/hooks` });
  const hook = { config: { url: "https://hooks.example.test/path/secret?token=abc" } };
  const fail = await ORGANISATION_KINDS["org-webhooks-none"](
    context({ read: stubReader({ [`/orgs/${O}/hooks`]: ok([hook]) }) }),
  );
  expect(fail).toMatchObject({ status: "fail", reason: "Organisation webhook to `hooks.example.test` added" });
  expect(fail.reason).not.toContain("secret");
});

test("org-webhooks is Unknown naming Webhooks read on a 403", async () => {
  const result = await ORGANISATION_KINDS["org-webhooks-none"](
    context({ read: stubReader({ [`/orgs/${O}/hooks`]: { status: 403 } }) }),
  );
  expect(result.status).toBe("unknown");
  expect(result.reason).toContain("Webhooks read");
});

test("org-secrets passes for known names and fails naming an unknown one", async () => {
  const secrets = (/** @type {string[]} */ names) => ({
    [`/orgs/${O}/actions/secrets`]: ok({ total_count: names.length, secrets: names.map(name => ({ name })) }),
  });
  const pass = await ORGANISATION_KINDS["org-secrets-known"](
    context({ read: stubReader(secrets(["BOARD_SYNC_APP_PRIVATE_KEY"])) }),
  );
  expect(pass).toMatchObject({ status: "pass", link: `${BASE}/settings/secrets/actions` });
  const fail = await ORGANISATION_KINDS["org-secrets-known"](
    context({ read: stubReader(secrets(["BOARD_SYNC_APP_PRIVATE_KEY", "STRAY"])) }),
  );
  expect(fail).toMatchObject({ status: "fail", reason: "Unexpected organisation secret `STRAY`" });
  const allowed = await ORGANISATION_KINDS["org-secrets-known"](
    context({ read: stubReader(secrets(["STRAY"])), exempt: match => (match === "STRAY" ? "Temporary" : null) }),
  );
  expect(allowed.status).toBe("pass");
});

test("org-secrets is Unknown naming Secrets read on a 403", async () => {
  const result = await ORGANISATION_KINDS["org-secrets-known"](
    context({ read: stubReader({ [`/orgs/${O}/actions/secrets`]: { status: 403 } }) }),
  );
  expect(result.status).toBe("unknown");
  expect(result.reason).toContain("Secrets read");
});

test("org-settings passes when every standard setting matches", async () => {
  expect(await ORGANISATION_KINDS["org-settings-match"](context())).toMatchObject({
    status: "pass",
    link: `${BASE}/settings/member_privileges`,
  });
});

test("org-settings fails naming a setting that differs", async () => {
  const live = { ...goodLive, members_can_create_repositories: true };
  expect(await ORGANISATION_KINDS["org-settings-match"](context({ live }))).toMatchObject({
    status: "fail",
    reason: "`members_can_create_repositories` is `true`, expected `false`",
  });
});

test("org-settings is Unknown naming a setting GitHub didn't show, but a mismatch still fails", async () => {
  const { two_factor_requirement_enabled: _hidden, ...live } = goodLive;
  const hidden = await ORGANISATION_KINDS["org-settings-match"](context({ live }));
  expect(hidden.status).toBe("unknown");
  expect(hidden.reason).toContain("`two_factor_requirement_enabled`");
  const both = await ORGANISATION_KINDS["org-settings-match"](
    context({ live: { ...live, default_repository_permission: "write" } }),
  );
  expect(both.status).toBe("fail");
});
