import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { routeResults } from "../src/api/results.js";
import { clearAccessKeyCache } from "../src/lib/access.js";
import worker from "../src/worker.js";

const TEAM = "team.example.test";
const AUDIENCE = "results-aud";
const CLIENT = "engage-client.access";
const production = {
  ...env,
  APP_ENV: "production",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_RESULTS_AUD: AUDIENCE,
  RESULTS_CLIENT_ID: CLIENT,
};

const get = (/** @type {string} */ path, method = "GET") => new Request(`https://api.example.test${path}`, { method });

beforeEach(async () => {
  await env.DB.batch(
    ["results", "security_events", "repositories", "exceptions", "settings", "standard"].map(table =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
  clearAccessKeyCache();
});
afterEach(() => vi.unstubAllGlobals());

/** @param {string} target @param {string} check @param {string} status @param {string} reason */
const result = (target, check, status, reason) =>
  env.DB.prepare(
    `INSERT INTO results (target, check_id, status, reason, link, checked_at, changed_at, changed_by)
     VALUES (?1, ?2, ?3, ?4, 'https://example.test/x', '2026-11-28T10:00:00.000Z', '2026-11-28T10:00:00.000Z', 'sweep')`,
  )
    .bind(target, check, status, reason)
    .run();

async function pin() {
  const body = JSON.stringify({ checks: [{ id: "deploy-keys", title: "Deploy keys" }] });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO standard (version, sha256, body, verified_at) VALUES ('v1.18.0', ?1, ?2, 'now')").bind(
      sha256,
      body,
    ),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('standard', ?1)").bind(
      JSON.stringify({ version: "v1.18.0", sha256 }),
    ),
  ]);
}

/** @param {string} target @param {string} action @param {string} at */
const event = (target, action, at) =>
  env.DB.prepare(
    "INSERT INTO security_events (source, target, action, actor, detail, occurred_at) VALUES ('github', ?1, ?2, 'octocat', 'did a thing', ?3)",
  )
    .bind(target, action, at)
    .run();

test("lists every result with the pinned version", async () => {
  await pin();
  await result("engage", "deploy-keys", "fail", "A key");
  await result("organisation", "two-factor", "pass", "");
  await result("cloudflare", "audit-log", "pass", "");
  const response = await routeResults(get("/v1/results"), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = /** @type {any} */ (await response.json());
  expect(body.standard).toEqual({ version: "v1.18.0" });
  expect(body.results.map((/** @type {any} */ row) => `${row.target}/${row.check}`)).toEqual([
    "engage/deploy-keys",
    "cloudflare/audit-log",
    "organisation/two-factor",
  ]);
  expect(body.results[0]).toEqual({
    target: "engage",
    check: "deploy-keys",
    title: "Deploy keys",
    status: "fail",
    reason: "A key",
    link: "https://example.test/x",
    checkedAt: "2026-11-28T10:00:00.000Z",
  });
  expect(body.results[1].title).toBe("Cloudflare audit log");
});

test("an unpinned standard gives a null version", async () => {
  const body = /** @type {any} */ (await (await routeResults(get("/v1/results"), env)).json());
  expect(body).toEqual({ standard: null, results: [] });
});

test("one repository's results and its last 10 events", async () => {
  await result("engage", "deploy-keys", "pass", "");
  await result("other", "deploy-keys", "fail", "x");
  for (let minute = 0; minute < 12; minute++) {
    await event("engage", `push.${minute}`, `2026-11-28T10:${String(minute).padStart(2, "0")}:00.000Z`);
  }
  await event("other", "push.other", "2026-11-28T11:00:00.000Z");
  const response = await routeResults(get("/v1/results/engage"), env);
  const body = /** @type {any} */ (await response.json());
  expect(body.repository).toBe("engage");
  expect(body.results.map((/** @type {any} */ row) => row.target)).toEqual(["engage"]);
  expect(body.events).toHaveLength(10);
  expect(body.events[0]).toEqual({
    action: "push.11",
    actor: "octocat",
    detail: "did a thing",
    at: "2026-11-28T10:11:00.000Z",
  });
  expect(body.events[9].action).toBe("push.2");
});

test("a repository with no results yet is known by its row", async () => {
  await env.DB.prepare("INSERT INTO repositories (name) VALUES ('fresh')").run();
  const body = /** @type {any} */ (await (await routeResults(get("/v1/results/fresh"), env)).json());
  expect(body).toEqual({ repository: "fresh", results: [], events: [] });
});

test("an unknown or malformed repository is 404", async () => {
  await result("engage", "deploy-keys", "pass", "");
  for (const path of [
    "/v1/results/unknown",
    "/v1/results/..%2Fsettings",
    "/v1/results/%2e%2e",
    "/v1/results/%E0%A4%A",
    "/v1/results/a%20b",
    `/v1/results/${"a".repeat(101)}`,
    "/v1/results/engage/extra",
    "/v1/results/",
    "/v1/settings",
  ]) {
    const response = await routeResults(get(path), env);
    expect(response.status, path).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
});

test("a method other than GET is 405", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await routeResults(get("/v1/results", method), env);
    expect(response.status, method).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  }
});

test("no exception reasons or settings leak", async () => {
  await result("engage", "deploy-keys", "pass", "");
  await env.DB.prepare(
    "INSERT INTO exceptions (target, check_id, reason) VALUES ('engage', 'deploy-keys', 'secret reason')",
  ).run();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('owners', '[\"someone\"]')").run();
  const list = /** @type {any} */ (await (await routeResults(get("/v1/results"), env)).json());
  const one = /** @type {any} */ (await (await routeResults(get("/v1/results/engage"), env)).json());
  expect(Object.keys(list).sort()).toEqual(["results", "standard"]);
  expect(Object.keys(one).sort()).toEqual(["events", "repository", "results"]);
  expect(Object.keys(one.results[0]).sort()).toEqual([
    "check",
    "checkedAt",
    "link",
    "reason",
    "status",
    "target",
    "title",
  ]);
  expect(JSON.stringify([list, one])).not.toMatch(/secret reason|someone/);
});

/** @param {object} claims */
async function serviceJwt(claims) {
  const pair = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )
  );
  const b64 = (/** @type {Uint8Array} */ bytes) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const part = (/** @type {object} */ value) => b64(new TextEncoder().encode(JSON.stringify(value)));
  const header = part({ alg: "RS256", kid: "k1" });
  const payload = part({ aud: [AUDIENCE], iss: `https://${TEAM}`, exp: Date.now() / 1000 + 300, ...claims });
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  vi.stubGlobal("fetch", async () => Response.json({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] }));
  return `${header}.${payload}.${b64(signature)}`;
}

/** @param {string} path @param {string} [token] */
const viaWorker = (path, token) =>
  worker.fetch(
    new Request(`https://api.example.test${path}`, token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : {}),
    production,
    { waitUntil() {} },
  );

test("refuses without a valid service token", async () => {
  await result("engage", "deploy-keys", "pass", "");
  for (const path of ["/v1/results", "/v1/results/engage", "/v1/anything"]) {
    const response = await viaWorker(path);
    expect(response.status, path).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Forbidden" });
  }
  const owner = await serviceJwt({ email: "owner@example.test" });
  expect((await viaWorker("/v1/results", owner)).status).toBe(403);
  const wrongAudience = await serviceJwt({ aud: ["other"], common_name: CLIENT });
  expect((await viaWorker("/v1/results", wrongAudience)).status).toBe(403);
});

test("serves the results to Engage's service token and 404s unknown paths behind it", async () => {
  await result("engage", "deploy-keys", "pass", "");
  const token = await serviceJwt({ common_name: CLIENT, type: "app" });
  const ok = await viaWorker("/v1/results", token);
  expect(ok.status).toBe(200);
  expect((await ok.json()) /** @type {any} */.results).toHaveLength(1);
  expect((await viaWorker("/v1/nothing", token)).status).toBe(404);
  expect((await viaWorker("/v1/results/..%2Fsettings", token)).status).toBe(404);
});
