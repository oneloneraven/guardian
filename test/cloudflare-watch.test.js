import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deliverPending } from "../src/alerts/outbox.js";
import { watchAudit } from "../src/cloudflare/watch.js";

const NOW = Date.UTC(2026, 10, 28, 12, 0);
const MINUTE = 60_000;
const config = {
  ...env,
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_AUDIT_TOKEN: "t",
  DISCORD_WEBHOOK_URL: "https://discord.example.test/api/webhooks/1/t",
};

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await env.DB.batch(
    ["alerts", "security_events", "cursors", "results", "known_tokens", "settings"].map(table =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('check-alerts', ?1)")
    .bind(JSON.stringify("on"))
    .run();
});

/** @param {string} id @param {Record<string, any>} [over] */
const raw = (id, over = {}) => ({
  id,
  action: {
    type: "create",
    result: "success",
    description: "Create token",
    time: new Date(NOW - 2 * MINUTE).toISOString(),
  },
  actor: { type: "user", context: "dashboard", email: "someone@example.com" },
  resource: { id: "res", type: "token", product: "api_tokens", scope: "accounts" },
  ...over,
});

/** @param {any[]} result @param {number} [status] */
function cloudflare(result, status = 200) {
  const posted = /** @type {string[]} */ ([]);
  vi.stubGlobal("fetch", async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url).startsWith("https://discord.example.test")) {
      posted.push(JSON.parse(init.body).content);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ success: status === 200, result, result_info: { cursor: "" } }), { status });
  });
  return posted;
}

const auditResult = async () =>
  await env.DB.prepare("SELECT status, reason, unknown_sweeps FROM results WHERE target = 'cloudflare'").first();
const count = async (/** @type {string} */ where) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM alerts WHERE ${where}`).first())?.n;

test("a token created alerts once and posts once", async () => {
  const posted = cloudflare([raw("a")]);
  await watchAudit(config, NOW);
  await watchAudit(config, NOW + 5 * MINUTE);
  await deliverPending(config);
  await deliverPending(config);
  expect(await count("kind = 'cloudflare'")).toBe(1);
  expect(posted).toEqual(["`a dashboard user` created API token `res`"]);
  expect((await auditResult())?.status).toBe("pass");
});

test("two failed reads in a row alert once", async () => {
  const posted = cloudflare([], 500);
  await watchAudit(config, NOW);
  expect(await count("1 = 1")).toBe(0);
  await watchAudit(config, NOW + 5 * MINUTE);
  await watchAudit(config, NOW + 10 * MINUTE);
  await deliverPending(config);
  expect(await count("kind = 'unknown'")).toBe(1);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain("Cloudflare audit log");
  expect(posted[0]).toContain("HTTP 500");
});

test("info lines post while alerts are on", async () => {
  await env.DB.prepare(
    "INSERT INTO known_tokens (token_id, name, purpose) VALUES ('co', 'Coraxia', 'Coraxia infra apply')",
  ).run();
  const posted = cloudflare([
    raw("i", {
      actor: { type: "account", context: "api", token_id: "co", token_name: "coraxia" },
      resource: { id: "app-1", type: "application", product: "access", scope: "accounts" },
      action: {
        type: "update",
        result: "success",
        description: "Update app",
        time: new Date(NOW - MINUTE).toISOString(),
      },
    }),
  ]);
  await watchAudit(config, NOW);
  await deliverPending(config);
  expect(posted).toEqual(["Coraxia changed access `app-1`: Update app"]);
});

test("info lines stay pending while alerts are off", async () => {
  await env.DB.prepare("UPDATE settings SET value = ?1 WHERE key = 'check-alerts'").bind(JSON.stringify("off")).run();
  const posted = cloudflare([raw("a")]);
  await watchAudit(config, NOW);
  await deliverPending(config);
  expect(posted).toEqual([]);
  expect(await count("notified = 0")).toBe(1);
});

test("a routine deploy posts nothing", async () => {
  await env.DB.prepare(
    "INSERT INTO known_tokens (token_id, name, purpose, repository) VALUES ('d', 'Deploy', 'Deploys Guardian', 'guardian')",
  ).run();
  const posted = cloudflare([
    raw("w", {
      actor: { type: "account", context: "api", token_id: "d", token_name: "deploy" },
      resource: { id: "guardian-production", type: "script", product: "workers", scope: "accounts" },
      action: { type: "update", result: "success", description: "Deploy", time: new Date(NOW - MINUTE).toISOString() },
    }),
  ]);
  await watchAudit(config, NOW);
  await deliverPending(config);
  expect(posted).toEqual([]);
  expect(await count("1 = 1")).toBe(0);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM security_events").first())?.n).toBe(1);
});

test("two different entries both alert", async () => {
  const posted = cloudflare([raw("a"), raw("b")]);
  await watchAudit(config, NOW);
  await deliverPending(config);
  expect(posted).toHaveLength(2);
});
