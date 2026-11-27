import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { deliverPending, raise } from "../src/alerts/outbox.js";

const base = { DB: env.DB, DISCORD_WEBHOOK_URL: "https://discord.example.test/api/webhooks/1/t" };

/** @param {number} [status] */
function discord(status = 204) {
  /** @type {string[]} */
  const posted = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (_url, init) => {
    posted.push(JSON.parse(String(init?.body)).content);
    return new Response(null, { status });
  };
  return { posted, fetchImpl };
}

/** @param {"on" | "off"} state */
const setSwitch = state =>
  env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('check-alerts', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1",
  )
    .bind(JSON.stringify(state))
    .run();

/** @param {string} target @param {string} check @param {string} status @param {string} reason */
const setResult = (target, check, status, reason) =>
  env.DB.prepare(
    `INSERT INTO results (target, check_id, status, reason, checked_at, changed_at, changed_by)
     VALUES (?1, ?2, ?3, ?4, 'now', 'now', 'sweep')
     ON CONFLICT (target, check_id) DO UPDATE SET status = ?3, reason = ?4`,
  )
    .bind(target, check, status, reason)
    .run();

/** @param {string} reason */
const failAlert = reason => ({
  kind: /** @type {const} */ ("fail"),
  target: "engage",
  subject: "deploy-keys",
  text: `engage: Deploy keys failed: ${reason}.`,
});
const resolvedAlert = {
  kind: /** @type {const} */ ("resolved"),
  target: "engage",
  subject: "deploy-keys",
  text: "engage: Deploy keys resolved.",
};

const rows = async () => (await env.DB.prepare("SELECT kind, reason, notified FROM alerts ORDER BY id").all()).results;

beforeEach(async () => {
  await env.DB.batch(
    ["alerts", "settings", "results", "repositories"].map(table => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});

test("a reason change on a Fail raises again; the same reason doesn't", async () => {
  await raise(env, failAlert("Deploy key `a` added"));
  await raise(env, failAlert("Deploy key `a` added"));
  expect(await rows()).toHaveLength(1);
  await raise(env, failAlert("Deploy key `b` added"));
  expect(await rows()).toHaveLength(2);
});

test("a Fail that comes back after it resolved raises again", async () => {
  await raise(env, failAlert("Deploy key `a` added"));
  await raise(env, resolvedAlert);
  await env.DB.prepare("UPDATE alerts SET notified = 1").run();
  await raise(env, failAlert("Deploy key `a` added"));
  expect((await rows()).map(row => row.kind)).toEqual(["fail", "resolved", "fail"]);
});

test("a new repository is announced once, ever", async () => {
  const alert = {
    kind: /** @type {const} */ ("new-repository"),
    target: "newcomer",
    subject: "visibility",
    text: "New repository newcomer: set its expected visibility.",
  };
  await raise(env, alert);
  await env.DB.prepare("UPDATE alerts SET notified = 1").run();
  await raise(env, alert);
  expect(await rows()).toHaveLength(1);
});

test("deliverPending posts nothing while check alerts are off, and posts pending Fails once switched on", async () => {
  await setResult("engage", "deploy-keys", "fail", "Deploy key `a` added");
  await raise(env, failAlert("Deploy key `a` added"));
  const out = discord();
  expect(await deliverPending(base, out.fetchImpl)).toBe(0);
  await setSwitch("off");
  expect(await deliverPending(base, out.fetchImpl)).toBe(0);
  expect(out.posted).toEqual([]);
  expect((await rows())[0].notified).toBe(0);

  await setSwitch("on");
  expect(await deliverPending(base, out.fetchImpl)).toBe(1);
  expect(out.posted).toEqual(["engage: Deploy keys failed: Deploy key `a` added."]);
  expect((await rows())[0].notified).toBe(1);
  expect(await deliverPending(base, out.fetchImpl)).toBe(0);
  expect(out.posted).toHaveLength(1);
});

test("a Fail that resolved while alerts were off is never posted", async () => {
  await setSwitch("off");
  await setResult("engage", "deploy-keys", "fail", "Deploy key `a` added");
  await raise(env, failAlert("Deploy key `a` added"));
  await setResult("engage", "deploy-keys", "pass", "No deploy keys");
  await raise(env, resolvedAlert);
  await setSwitch("on");
  const out = discord();
  expect(await deliverPending(base, out.fetchImpl)).toBe(0);
  expect(out.posted).toEqual([]);
  expect((await rows()).map(row => row.notified)).toEqual([1, 1]);
});

test("a Fail whose reason has since changed is not posted, but the newer one is", async () => {
  await setSwitch("on");
  await setResult("engage", "deploy-keys", "fail", "Deploy key `b` added");
  await raise(env, failAlert("Deploy key `a` added"));
  await raise(env, failAlert("Deploy key `b` added"));
  const out = discord();
  expect(await deliverPending(base, out.fetchImpl)).toBe(1);
  expect(out.posted).toEqual(["engage: Deploy keys failed: Deploy key `b` added."]);
});

test("a resolved alert is posted when its Fail was posted", async () => {
  await setSwitch("on");
  await setResult("engage", "deploy-keys", "fail", "Deploy key `a` added");
  await raise(env, failAlert("Deploy key `a` added"));
  const out = discord();
  await deliverPending(base, out.fetchImpl);
  await setResult("engage", "deploy-keys", "pass", "No deploy keys");
  await raise(env, resolvedAlert);
  expect(await deliverPending(base, out.fetchImpl)).toBe(1);
  expect(out.posted).toEqual(["engage: Deploy keys failed: Deploy key `a` added.", "engage: Deploy keys resolved."]);
});

test("a new-repository alert is dropped once its visibility is set", async () => {
  await setSwitch("on");
  await env.DB.prepare("INSERT INTO repositories (name, expected_visibility) VALUES ('newcomer', 'public')").run();
  await raise(env, {
    kind: "new-repository",
    target: "newcomer",
    subject: "visibility",
    text: "New repository newcomer.",
  });
  const out = discord();
  expect(await deliverPending(base, out.fetchImpl)).toBe(0);
  expect(out.posted).toEqual([]);
});

test("deliverPending stops at the first Discord failure and leaves the rest pending", async () => {
  await setSwitch("on");
  await setResult("engage", "deploy-keys", "fail", "Deploy key `a` added");
  await setResult("engage", "webhooks", "fail", "Webhook to `x.example.test` added");
  await raise(env, failAlert("Deploy key `a` added"));
  await raise(env, {
    kind: "fail",
    target: "engage",
    subject: "webhooks",
    text: "engage: Webhooks failed: Webhook to `x.example.test` added.",
  });
  const out = discord(500);
  expect(await deliverPending(base, out.fetchImpl)).toBe(0);
  expect(out.posted).toHaveLength(1);
  expect((await rows()).map(row => row.notified)).toEqual([0, 0]);
  const retry = discord();
  expect(await deliverPending(base, retry.fetchImpl)).toBe(2);
});
