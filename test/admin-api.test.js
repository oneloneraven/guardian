import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { GithubUnavailable } from "../src/github/app.js";
import { routeAdmin } from "../src/admin/router.js";
import real from "./fixtures/standard-v1.18.0.json?raw";

const OWNER = "owner@example.test";
const HOST = "guardian.example.test";
const REAL_SHA = "469aeb66711b9d2532db06ac84123082745ff2fd949a74765fdf025b034a2402";
const WEBHOOK = "https://discord.example.test/api/webhooks/1/t";
const base = { DB: env.DB, OWNER_EMAIL: OWNER, ADMIN_HOST: HOST, DISCORD_WEBHOOK_URL: WEBHOOK };
const owner = { email: OWNER };
const stranger = { email: "someone@example.test" };

/** @returns {{ fetchImpl: typeof fetch, posted: string[], requested: string[] }} */
function outbound() {
  /** @type {string[]} */
  const posted = [];
  /** @type {string[]} */
  const requested = [];
  return {
    posted,
    requested,
    fetchImpl: async (url, init) => {
      requested.push(String(url));
      if (String(url) === WEBHOOK) {
        posted.push(JSON.parse(String(init?.body)).content);
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("/v1.18.0/standard.json")) return new Response(real);
      return new Response("Not Found", { status: 404 });
    },
  };
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {Record<string, string>} [headers]
 */
function call(method, path, body, headers = {}) {
  return new Request(`https://${HOST}${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * @param {Request} request
 * @param {{ email: string }} [identity]
 * @param {typeof fetch} [fetchImpl]
 */
const send = (request, identity = owner, fetchImpl = outbound().fetchImpl, options = undefined) =>
  routeAdmin(request, base, identity, fetchImpl, options);

const auditCount = async () => (await env.DB.prepare("SELECT count(*) AS n FROM settings_audit").first())?.n;

beforeEach(async () => {
  await env.DB.batch(
    [
      "settings",
      "settings_audit",
      "standard",
      "repositories",
      "exceptions",
      "known_tokens",
      "results",
      "security_events",
    ].map(t => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});

const ROUTES = [
  ["GET", "/api/settings", undefined],
  ["PUT", "/api/owners", { values: ["raven"] }],
  ["PUT", "/api/apps", { values: ["engage"] }],
  ["PUT", "/api/alerts", { enabled: true }],
  ["PUT", "/api/repositories/engage", { expectedVisibility: "public" }],
  ["POST", "/api/exceptions", { target: "engage", check: "secrets-known", reason: "Better Stack" }],
  ["DELETE", "/api/exceptions/1", undefined],
  ["POST", "/api/tokens", { tokenId: "abc123", name: "Engage Deploy", purpose: "Deploys Engage" }],
  ["DELETE", "/api/tokens/abc123", undefined],
  ["POST", "/api/standard", { version: "v1.18.0", sha256: REAL_SHA }],
  ["GET", "/api/results", undefined],
  ["GET", "/api/events", undefined],
  ["GET", "/api/repositories/engage/record", undefined],
  ["PUT", "/api/repositories/engage/record", { sha: "a".repeat(40) }],
  ["GET", "/api/nowhere", undefined],
];

test("every /api route answers 403 to a non-owner, reads included, and changes nothing", async () => {
  await env.DB.prepare("INSERT INTO exceptions (id, target, check_id, reason) VALUES (1, 'engage', 'x', 'kept')").run();
  await env.DB.prepare(
    "INSERT INTO known_tokens (token_id, name, purpose) VALUES ('abc123', 'Engage Deploy', 'kept')",
  ).run();
  const out = outbound();
  for (const [method, path, body] of ROUTES) {
    const response = await send(call(String(method), String(path), body), stranger, out.fetchImpl);
    expect(response.status, `${method} ${path}`).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect(await auditCount()).toBe(0);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM settings").first())?.n).toBe(0);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM exceptions").first())?.n).toBe(1);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM known_tokens").first())?.n).toBe(1);
  expect(out.requested).toEqual([]);
});

test("an owner identity without OWNER_EMAIL configured is refused", async () => {
  const response = await routeAdmin(call("GET", "/api/settings"), { ...base, OWNER_EMAIL: "" }, { email: "" });
  expect(response.status).toBe(403);
});

test("GET /api/settings returns every section, empty to start with", async () => {
  const response = await send(call("GET", "/api/settings"));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({
    standard: null,
    owners: [],
    apps: [],
    alerts: { enabled: false },
    repositories: [],
    exceptions: [],
    tokens: [],
    audit: [],
  });
});

test("each mutation is saved, audited and announced once", async () => {
  const out = outbound();
  const steps = [
    ["PUT", "/api/owners", { values: ["raven", "nix-2"] }, "owners"],
    ["PUT", "/api/apps", { values: ["engage", "guardian"] }, "apps"],
    ["PUT", "/api/repositories/engage", { expectedVisibility: "public" }, "repositories"],
    ["POST", "/api/exceptions", { target: "engage", check: "secrets-known", reason: "Better Stack" }, "exceptions"],
    ["POST", "/api/tokens", { tokenId: "abc123", name: "Engage Deploy", purpose: "Deploys Engage" }, "tokens"],
    ["POST", "/api/standard", { version: "v1.18.0", sha256: REAL_SHA }, "standard"],
  ];
  for (const [method, path, body] of steps) {
    const response = await send(call(String(method), String(path), body), owner, out.fetchImpl);
    expect(response.status, `${method} ${path}`).toBeLessThan(300);
  }
  expect(out.posted).toEqual(
    steps.map(([, , , key]) => `Guardian settings: the owner changed ${key}: https://${HOST}/`),
  );

  const settings = await (await send(call("GET", "/api/settings"))).json();
  expect(settings).toMatchObject({
    standard: { version: "v1.18.0" },
    owners: ["raven", "nix-2"],
    apps: ["engage", "guardian"],
    repositories: [{ name: "engage", expectedVisibility: "public", acceptedRecordSha: null }],
    exceptions: [{ target: "engage", check: "secrets-known", match: null, reason: "Better Stack" }],
    tokens: [{ tokenId: "abc123", name: "Engage Deploy", purpose: "Deploys Engage", repository: null }],
  });
  expect(settings.audit).toHaveLength(6);
  expect(settings.audit[0]).toMatchObject({ actor: "the owner", key: "standard", notified: true });

  const exceptionId = settings.exceptions[0].id;
  expect((await send(call("DELETE", `/api/exceptions/${exceptionId}`), owner, out.fetchImpl)).status).toBe(200);
  expect((await send(call("DELETE", "/api/tokens/abc123"), owner, out.fetchImpl)).status).toBe(200);
  expect(out.posted).toHaveLength(8);
  const after = await (await send(call("GET", "/api/settings"))).json();
  expect(after.exceptions).toEqual([]);
  expect(after.tokens).toEqual([]);
  expect(after.audit[0]).toMatchObject({
    key: "tokens",
    from: { tokenId: "abc123", name: "Engage Deploy", purpose: "Deploys Engage", repository: null },
    to: null,
  });
});

test("PUT /api/alerts is audited and announced, and refuses a non-boolean with 400", async () => {
  const out = outbound();
  const on = await send(call("PUT", "/api/alerts", { enabled: true }), owner, out.fetchImpl);
  expect(on.status).toBe(200);
  expect((await env.DB.prepare("SELECT value FROM settings WHERE key = 'check-alerts'").first())?.value).toBe('"on"');
  expect((await (await send(call("GET", "/api/settings"))).json()).alerts).toEqual({ enabled: true });
  const off = await send(call("PUT", "/api/alerts", { enabled: false }), owner, out.fetchImpl);
  expect(off.status).toBe(200);
  expect((await (await send(call("GET", "/api/settings"))).json()).alerts).toEqual({ enabled: false });
  expect(out.posted).toEqual([
    `Guardian settings: the owner changed check-alerts: https://${HOST}/`,
    `Guardian settings: the owner changed check-alerts: https://${HOST}/`,
  ]);
  const audit = (
    await env.DB.prepare("SELECT key, from_value, to_value, notified FROM settings_audit ORDER BY id").all()
  ).results;
  expect(audit).toEqual([
    { key: "check-alerts", from_value: "false", to_value: "true", notified: 1 },
    { key: "check-alerts", from_value: "true", to_value: "false", notified: 1 },
  ]);
  for (const enabled of ["on", 1, null, undefined]) {
    const response = await send(call("PUT", "/api/alerts", { enabled }), owner, out.fetchImpl);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "enabled must be true or false" });
  }
  expect(await auditCount()).toBe(2);
});

test("a blank exception reason or token purpose answers 400 and audits nothing", async () => {
  for (const reason of ["", "   ", undefined, 7]) {
    const response = await send(call("POST", "/api/exceptions", { target: "engage", check: "visibility", reason }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "reason is required" });
  }
  for (const purpose of ["", "  "]) {
    const response = await send(call("POST", "/api/tokens", { tokenId: "abc123", name: "Deploy", purpose }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "purpose is required" });
  }
  expect(await auditCount()).toBe(0);
});

test("invalid bodies answer 400 naming the field, and audit nothing", async () => {
  const cases = [
    ["PUT", "/api/owners", { values: ["ok", "not a login"] }, "values must be GitHub logins or App slugs"],
    ["PUT", "/api/owners", { values: "raven" }, "values must be GitHub logins or App slugs"],
    ["PUT", "/api/apps", {}, "values must be GitHub logins or App slugs"],
    [
      "PUT",
      "/api/repositories/engage",
      { expectedVisibility: "internal" },
      "expectedVisibility must be public or private",
    ],
    ["PUT", "/api/repositories/bad%20name", { expectedVisibility: "public" }, "name must be a repository name"],
    ["POST", "/api/exceptions", { check: "visibility", reason: "x" }, "target is required"],
    ["POST", "/api/exceptions", { target: "engage", check: "Not A Check", reason: "x" }, "check must be a check id"],
    ["POST", "/api/exceptions", { target: "engage", check: "visibility", match: 5, reason: "x" }, "match must be text"],
    ["POST", "/api/tokens", { tokenId: "a b", name: "n", purpose: "p" }, "tokenId must be a token id"],
    ["POST", "/api/tokens", { tokenId: "abc", purpose: "p" }, "name is required"],
    ["POST", "/api/tokens", { tokenId: "abc", name: "n", purpose: "p", repository: 1 }, "repository must be text"],
    ["POST", "/api/owners", { values: [] }, null],
  ];
  for (const [method, path, body, error] of cases) {
    const response = await send(call(String(method), String(path), body));
    if (error === null) {
      expect(response.status, `${method} ${path}`).toBe(405);
      continue;
    }
    expect(response.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
    expect(await response.json()).toEqual({ error });
  }
  const notJson = await send(call("PUT", "/api/owners", "{"));
  expect(notJson.status).toBe(400);
  expect(await notJson.json()).toEqual({ error: "body must be JSON" });
  expect(await auditCount()).toBe(0);
});

test("a mutation without a JSON content type is refused", async () => {
  const response = await send(
    new Request(`https://${HOST}/api/owners`, { method: "PUT", body: JSON.stringify({ values: ["raven"] }) }),
  );
  expect(response.status).toBe(415);
  expect(await auditCount()).toBe(0);
});

test("a mutation from another origin is refused", async () => {
  const response = await send(call("PUT", "/api/owners", { values: ["raven"] }, { Origin: "https://evil.example" }));
  expect(response.status).toBe(403);
  const same = await send(call("PUT", "/api/owners", { values: ["raven"] }, { Origin: `https://${HOST}` }));
  expect(same.status).toBe(200);
  expect(await auditCount()).toBe(1);
});

test("removing an exception or token that doesn't exist answers 404 and audits nothing", async () => {
  expect((await send(call("DELETE", "/api/exceptions/99"))).status).toBe(404);
  expect((await send(call("DELETE", "/api/exceptions/x"))).status).toBe(404);
  expect((await send(call("DELETE", "/api/tokens/nope"))).status).toBe(404);
  expect(await auditCount()).toBe(0);
});

test("adding a token id that's already known answers 409", async () => {
  const body = { tokenId: "abc123", name: "Engage Deploy", purpose: "Deploys Engage" };
  expect((await send(call("POST", "/api/tokens", body))).status).toBe(201);
  const again = await send(call("POST", "/api/tokens", body));
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "tokenId is already known" });
  expect(await auditCount()).toBe(1);
});

test("POST /api/standard answers 422 with the refusal reason", async () => {
  const wrong = "0".repeat(64);
  const response = await send(call("POST", "/api/standard", { version: "v1.18.0", sha256: wrong }));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: `Checksum mismatch: expected ${wrong}, got ${REAL_SHA}` });
  expect(await auditCount()).toBe(0);
});

test("an unknown route answers 404 and a wrong method 405", async () => {
  expect((await send(call("GET", "/api/nowhere"))).status).toBe(404);
  expect((await send(call("DELETE", "/api/settings"))).status).toBe(405);
});

test("owners and Apps are de-duplicated without regard to case, keeping the first spelling", async () => {
  expect((await send(call("PUT", "/api/owners", { values: ["Raven", "raven", "nix"] }))).status).toBe(200);
  expect((await (await send(call("GET", "/api/settings"))).json()).owners).toEqual(["Raven", "nix"]);
});

test("the settings show why a pinned standard isn't in use", async () => {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('standard', '{"version":"v1.18.0","sha256":"${REAL_SHA}"}')`,
  ).run();
  expect((await (await send(call("GET", "/api/settings"))).json()).standard).toEqual({
    version: "v1.18.0",
    unknown: "Pinned standard missing",
  });
});

test("a duplicate token that slips past the check answers 409, not 500", async () => {
  const db = {
    prepare: (/** @type {string} */ sql) =>
      sql.startsWith("SELECT 1 FROM known_tokens")
        ? { bind: () => ({ first: async () => null }) }
        : env.DB.prepare(sql),
    batch: (/** @type {any[]} */ statements) => env.DB.batch(statements),
  };
  await env.DB.prepare("INSERT INTO known_tokens (token_id, name, purpose) VALUES ('abc123', 'n', 'p')").run();
  const response = await routeAdmin(
    call("POST", "/api/tokens", { tokenId: "abc123", name: "n", purpose: "p" }),
    { ...base, DB: /** @type {any} */ (db) },
    owner,
    outbound().fetchImpl,
  );
  expect(response.status).toBe(409);
});

test("an unexpected failure answers a JSON 500 that isn't cached", async () => {
  const db = {
    prepare: () => {
      throw new Error("D1 unavailable");
    },
    batch: () => Promise.reject(new Error("D1 unavailable")),
  };
  const response = await routeAdmin(call("GET", "/api/settings"), { ...base, DB: /** @type {any} */ (db) }, owner);
  expect(response.status).toBe(500);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ error: "Something went wrong" });
});

test("a mutation from the page's own origin is accepted, port included", async () => {
  const request = new Request("http://localhost:4173/api/owners", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:4173" },
    body: JSON.stringify({ values: ["raven"] }),
  });
  expect((await send(request)).status).toBe(200);
  const elsewhere = new Request("http://localhost:4173/api/owners", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ values: ["raven"] }),
  });
  expect((await send(elsewhere)).status).toBe(403);
});

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
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

/** @param {{ status?: number, live?: { text: string, sha: string } | null, blobs?: Record<string, string> }} [options] */
function githubReader({ status = 200, live = { text: record({}), sha: NEW }, blobs = {} } = {}) {
  return async () => ({
    /** @param {string} path */
    async get(path) {
      if (path === "/repos/oneloneraven/engage") {
        return { status, body: status === 200 ? { default_branch: "main", visibility: "public" } : null };
      }
      if (path === "/orgs/oneloneraven") return { status: 200, body: { plan: { name: "Free" } } };
      return { status: 404, body: null };
    },
    async all() {
      return { status: 404, items: [] };
    },
    async file() {
      return live;
    },
    /** @param {string} _repo @param {string} sha */
    async blob(_repo, sha) {
      return blobs[sha] ?? null;
    },
  });
}

const addEngage = (/** @type {string | null} */ accepted = null) =>
  env.DB.prepare(
    "INSERT INTO repositories (name, expected_visibility, accepted_record_sha) VALUES ('engage', 'public', ?1)",
  )
    .bind(accepted)
    .run();

test("GET /api/repositories/:name/record returns the accepted and live records, parsed", async () => {
  await addEngage(OLD);
  const readerFor = githubReader({
    live: { text: record({ modules: ["core", "web-app"], flags: { beta: true } }), sha: NEW },
    blobs: { [OLD]: record({}) },
  });
  const response = await send(call("GET", "/api/repositories/engage/record"), owner, undefined, { readerFor });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    accepted: { sha: OLD, modules: ["core"], flags: {} },
    live: { sha: NEW, modules: ["core", "web-app"], flags: { beta: true } },
  });
});

test("GET /api/repositories/:name/record has no accepted record before one is accepted, and 404s an unknown repository", async () => {
  await addEngage();
  const readerFor = githubReader();
  const first = await send(call("GET", "/api/repositories/engage/record"), owner, undefined, { readerFor });
  expect(await first.json()).toMatchObject({ accepted: null, live: { sha: NEW } });
  const unknown = await send(call("GET", "/api/repositories/nope/record"), owner, undefined, { readerFor });
  expect(unknown.status).toBe(404);
});

test("GET /api/repositories/:name/record answers 502 when GitHub can't be read", async () => {
  await addEngage();
  for (const status of [0, 403, 500]) {
    const response = await send(call("GET", "/api/repositories/engage/record"), owner, undefined, {
      readerFor: githubReader({ status }),
    });
    expect(response.status, String(status)).toBe(502);
    expect(await response.json()).toEqual({ error: "Couldn't read the record from GitHub: try again in a minute." });
  }
  const unavailable = await send(call("GET", "/api/repositories/engage/record"), owner, undefined, {
    readerFor: async () => {
      throw new GithubUnavailable("github-app-not-configured");
    },
  });
  expect(unavailable.status).toBe(502);
});

test("accepting a record that changed since the page loaded answers 409", async () => {
  await addEngage(OLD);
  const response = await send(
    call("PUT", "/api/repositories/engage/record", { sha: "c".repeat(40) }),
    owner,
    undefined,
    {
      readerFor: githubReader(),
    },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "The record changed again: reload" });
  expect((await env.DB.prepare("SELECT accepted_record_sha FROM repositories").first())?.accepted_record_sha).toBe(OLD);
  expect(await auditCount()).toBe(0);
});

test("accepting a record needs a 40-character sha and a known repository", async () => {
  await addEngage();
  const readerFor = githubReader();
  for (const sha of ["abc", "G".repeat(40), 7, undefined]) {
    const response = await send(call("PUT", "/api/repositories/engage/record", { sha }), owner, undefined, {
      readerFor,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "sha must be a commit blob sha" });
  }
  const unknown = await send(call("PUT", "/api/repositories/nope/record", { sha: NEW }), owner, undefined, {
    readerFor,
  });
  expect(unknown.status).toBe(404);
});

test("accepting the live record is audited, announced, and makes record-accepted Pass on the next check", async () => {
  const out = outbound();
  await send(call("POST", "/api/standard", { version: "v1.18.0", sha256: REAL_SHA }), owner, out.fetchImpl);
  await addEngage(OLD);
  /** @type {Promise<unknown>[]} */
  const pending = [];
  const readerFor = githubReader({ blobs: { [OLD]: record({ modules: [] }) } });
  const response = await send(call("PUT", "/api/repositories/engage/record", { sha: NEW }), owner, out.fetchImpl, {
    readerFor,
    waitUntil: promise => void pending.push(promise),
  });
  expect(response.status).toBe(200);
  expect((await env.DB.prepare("SELECT accepted_record_sha FROM repositories").first())?.accepted_record_sha).toBe(NEW);
  const audit = (
    await env.DB.prepare("SELECT key, from_value, to_value, notified FROM settings_audit WHERE key = 'records'").all()
  ).results;
  expect(audit).toEqual([
    {
      key: "records",
      from_value: JSON.stringify(OLD),
      to_value: JSON.stringify({ name: "engage", sha: NEW }),
      notified: 1,
    },
  ]);
  expect(out.posted.at(-1)).toBe(`Guardian settings: the owner changed records: https://${HOST}/`);
  await Promise.allSettled(pending);
  expect(
    (
      await env.DB.prepare(
        "SELECT status FROM results WHERE target = 'engage' AND check_id = 'record-accepted'",
      ).first()
    )?.status,
  ).toBe("pass");
});

test("results are ordered with failures first", async () => {
  const insert = (/** @type {string} */ target, /** @type {string} */ check, /** @type {string} */ status) =>
    env.DB.prepare(
      "INSERT INTO results (target, check_id, status, reason, link, checked_at, changed_at, changed_by) VALUES (?1, ?2, ?3, 'why', 'https://github.com/x', 'now', 'now', 'sweep')",
    )
      .bind(target, check, status)
      .run();
  await insert("b", "visibility", "pass");
  await insert("a", "visibility", "unknown");
  await insert("b", "deploy-keys", "fail");
  await insert("a", "webhooks", "skipped");
  await insert("a", "deploy-keys", "fail");
  const body = await (await send(call("GET", "/api/results"))).json();
  expect(body.results.map((/** @type {any} */ row) => `${row.status}:${row.target}/${row.check}`)).toEqual([
    "fail:a/deploy-keys",
    "fail:b/deploy-keys",
    "unknown:a/visibility",
    "skipped:a/webhooks",
    "pass:b/visibility",
  ]);
  expect(body.results[0]).toEqual({
    target: "a",
    check: "deploy-keys",
    title: "deploy-keys",
    status: "fail",
    reason: "why",
    link: "https://github.com/x",
    checkedAt: "now",
  });
});

test("results carry the standard's check title when one is pinned", async () => {
  const out = outbound();
  await send(call("POST", "/api/standard", { version: "v1.18.0", sha256: REAL_SHA }), owner, out.fetchImpl);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO results (target, check_id, status, reason, checked_at, changed_at, changed_by) VALUES ('a', 'deploy-keys', 'fail', 'x', 'now', 'now', 'sweep')",
    ),
    env.DB.prepare(
      "INSERT INTO results (target, check_id, status, reason, checked_at, changed_at, changed_by) VALUES ('a', 'record-accepted', 'fail', 'x', 'now', 'now', 'sweep')",
    ),
  ]);
  const body = await (await send(call("GET", "/api/results"))).json();
  expect(body.results.map((/** @type {any} */ row) => row.title).sort()).toEqual(["Accepted record", "Deploy keys"]);
});

test("events are newest first and capped at 50", async () => {
  const statements = Array.from({ length: 55 }, (_, index) =>
    env.DB.prepare(
      "INSERT INTO security_events (source, target, action, actor, detail, occurred_at) VALUES ('github', 'engage', 'deploy_key.created', 'mallory', ?1, ?2)",
    ).bind(`event ${index}`, new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString()),
  );
  await env.DB.batch(statements);
  const body = await (await send(call("GET", "/api/events"))).json();
  expect(body.events).toHaveLength(50);
  expect(body.events[0]).toEqual({
    target: "engage",
    action: "deploy_key.created",
    actor: "mallory",
    actorTokenId: null,
    detail: "event 54",
    at: new Date(Date.UTC(2026, 10, 1, 0, 54)).toISOString(),
  });
  expect(body.events[49].detail).toBe("event 5");
});
