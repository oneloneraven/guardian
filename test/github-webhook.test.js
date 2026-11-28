import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GithubUnavailable } from "../src/github/app.js";
import { handleGithubWebhook } from "../src/github/webhook.js";
import { hmacHex } from "../src/lib/hmac.js";

const SECRET = "hook-secret";
const webhookEnv = { ...env, GITHUB_WEBHOOK_SECRET: SECRET, ADMIN_HOST: "guardian.example.test" };

function context() {
  /** @type {Promise<unknown>[]} */
  const pending = [];
  return {
    waitUntil: (/** @type {Promise<unknown>} */ promise) => void pending.push(promise),
    settled: () => Promise.allSettled(pending),
  };
}

/** @param {{ calls: number }} state */
const readerFor = state => async () => {
  state.calls++;
  return {
    async get() {
      return { status: 404, body: null };
    },
    async all() {
      return { status: 404, items: [] };
    },
    async file() {
      return null;
    },
    async blob() {
      return null;
    },
  };
};

/**
 * @param {unknown} payload
 * @param {{ event?: string, delivery?: string | null, secret?: string | null, signature?: string, body?: string, headers?: Record<string, string> }} [options]
 */
async function signed(
  payload,
  { event = "deploy_key", delivery = "d-1", secret = SECRET, signature, body, headers = {} } = {},
) {
  const text = body ?? JSON.stringify(payload);
  const sig = signature ?? (secret === null ? undefined : `sha256=${await hmacHex(secret, text)}`);
  return new Request("https://api.example.test/v1/github/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      ...(delivery ? { "X-GitHub-Delivery": delivery } : {}),
      ...(sig ? { "X-Hub-Signature-256": sig } : {}),
      ...headers,
    },
    body: text,
  });
}

const deployKey = {
  action: "created",
  sender: { login: "mallory" },
  repository: { name: "guardian", default_branch: "main" },
  key: { title: "ci box" },
};

const events = async () => (await env.DB.prepare("SELECT * FROM security_events ORDER BY id").all()).results;
const results = async () => (await env.DB.prepare("SELECT target, check_id, changed_by FROM results").all()).results;

beforeEach(async () => {
  await env.DB.batch(
    ["security_events", "results", "repositories", "alerts", "settings", "standard"].map(table =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

test("an unsigned body answers 401 and stores nothing", async () => {
  const ctx = context();
  const state = { calls: 0 };
  const response = await handleGithubWebhook(await signed(deployKey, { secret: null }), webhookEnv, ctx, {
    readerFor: readerFor(state),
  });
  expect(response.status).toBe(401);
  const wrong = await handleGithubWebhook(
    await signed(deployKey, { signature: `sha256=${"0".repeat(64)}` }),
    webhookEnv,
    ctx,
    {
      readerFor: readerFor(state),
    },
  );
  expect(wrong.status).toBe(401);
  await ctx.settled();
  expect(await events()).toEqual([]);
  expect(state.calls).toBe(0);
});

test("a missing webhook secret answers 401 and logs it", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await handleGithubWebhook(
    await signed(deployKey),
    { ...webhookEnv, GITHUB_WEBHOOK_SECRET: undefined },
    context(),
  );
  expect(response.status).toBe(401);
  expect(log).toHaveBeenCalledWith("GitHub webhook secret isn't set");
});

test("only POST is served", async () => {
  const response = await handleGithubWebhook(
    new Request("https://api.example.test/v1/github/webhook"),
    webhookEnv,
    context(),
  );
  expect(response.status).toBe(404);
});

test("a 6 MB body answers 413", async () => {
  const big = "x".repeat(6 * 1024 * 1024);
  const response = await handleGithubWebhook(await signed(null, { body: big }), webhookEnv, context());
  expect(response.status).toBe(413);
  const declared = await signed(deployKey, { headers: { "Content-Length": String(6 * 1024 * 1024) } });
  expect((await handleGithubWebhook(declared, webhookEnv, context())).status).toBe(413);
  expect(await events()).toEqual([]);
});

test("a body that isn't JSON answers 400, and a delivery with no id answers 400", async () => {
  expect((await handleGithubWebhook(await signed(null, { body: "{nope" }), webhookEnv, context())).status).toBe(400);
  expect((await handleGithubWebhook(await signed(deployKey, { delivery: null }), webhookEnv, context())).status).toBe(
    400,
  );
  expect(await events()).toEqual([]);
});

test("a deploy_key created event is stored with the sender's login and re-checks that repository", async () => {
  const ctx = context();
  const state = { calls: 0 };
  const response = await handleGithubWebhook(await signed(deployKey), webhookEnv, ctx, { readerFor: readerFor(state) });
  expect(response.status).toBe(202);
  await ctx.settled();
  expect(await events()).toMatchObject([
    {
      source: "github",
      target: "guardian",
      action: "deploy_key.created",
      actor: "mallory",
      detail: "`mallory` added deploy key `ci box`",
      delivery: "d-1",
    },
  ]);
  expect(state.calls).toBe(1);
  expect(await results()).toEqual([{ target: "guardian", check_id: "record-accepted", changed_by: "event" }]);
});

test("a redelivered event is stored once and re-checks once", async () => {
  const ctx = context();
  const state = { calls: 0 };
  const first = await handleGithubWebhook(await signed(deployKey), webhookEnv, ctx, { readerFor: readerFor(state) });
  const second = await handleGithubWebhook(await signed(deployKey), webhookEnv, ctx, { readerFor: readerFor(state) });
  expect([first.status, second.status]).toEqual([202, 202]);
  await ctx.settled();
  expect(await events()).toHaveLength(1);
  expect(state.calls).toBe(1);
});

test("a push that doesn't touch .bootstrap/record.json answers 204 and stores nothing", async () => {
  const payload = {
    ref: "refs/heads/main",
    sender: { login: "raven" },
    repository: { name: "guardian", default_branch: "main" },
    commits: [{ added: ["a.js"], modified: [], removed: [] }],
  };
  const ctx = context();
  const state = { calls: 0 };
  const response = await handleGithubWebhook(await signed(payload, { event: "push" }), webhookEnv, ctx, {
    readerFor: readerFor(state),
  });
  expect(response.status).toBe(204);
  await ctx.settled();
  expect(await events()).toEqual([]);
  expect(state.calls).toBe(0);
});

test("ping answers 204", async () => {
  const response = await handleGithubWebhook(
    await signed({ zen: "Keep it simple." }, { event: "ping" }),
    webhookEnv,
    context(),
  );
  expect(response.status).toBe(204);
});

test("an organisation event re-checks the organisation, and installation_repositories re-checks each added repository", async () => {
  const ctx = context();
  const state = { calls: 0 };
  await handleGithubWebhook(
    await signed(
      {
        action: "added",
        sender: { login: "raven" },
        repositories_added: [{ name: "one" }, { name: "two" }],
      },
      { event: "installation_repositories", delivery: "d-2" },
    ),
    webhookEnv,
    ctx,
    { readerFor: readerFor(state) },
  );
  await ctx.settled();
  expect(state.calls).toBe(1);
  expect((await results()).map(row => row.target).sort()).toEqual(["one", "two"]);
  expect(await events()).toMatchObject([{ target: "organisation", action: "installation_repositories.added" }]);
});

test("GitHub being unavailable during the re-check doesn't throw out of the work", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const ctx = context();
  const response = await handleGithubWebhook(await signed(deployKey), webhookEnv, ctx, {
    readerFor: async () => {
      throw new GithubUnavailable("github-app-not-configured");
    },
  });
  expect(response.status).toBe(202);
  expect((await ctx.settled()).every(outcome => outcome.status === "fulfilled")).toBe(true);
  expect(log).toHaveBeenCalled();
  expect(await events()).toHaveLength(1);
});
