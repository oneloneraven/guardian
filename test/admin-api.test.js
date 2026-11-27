import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
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
const send = (request, identity = owner, fetchImpl = outbound().fetchImpl) =>
  routeAdmin(request, base, identity, fetchImpl);

const auditCount = async () => (await env.DB.prepare("SELECT count(*) AS n FROM settings_audit").first())?.n;

beforeEach(async () => {
  await env.DB.batch(
    ["settings", "settings_audit", "standard", "repositories", "exceptions", "known_tokens"].map(t =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});

const ROUTES = [
  ["GET", "/api/settings", undefined],
  ["PUT", "/api/owners", { values: ["raven"] }],
  ["PUT", "/api/apps", { values: ["engage"] }],
  ["PUT", "/api/repositories/engage", { expectedVisibility: "public" }],
  ["POST", "/api/exceptions", { target: "engage", check: "secrets-known", reason: "Better Stack" }],
  ["DELETE", "/api/exceptions/1", undefined],
  ["POST", "/api/tokens", { tokenId: "abc123", name: "Engage Deploy", purpose: "Deploys Engage" }],
  ["DELETE", "/api/tokens/abc123", undefined],
  ["POST", "/api/standard", { version: "v1.18.0", sha256: REAL_SHA }],
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
