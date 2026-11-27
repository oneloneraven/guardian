import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runScheduled } from "../src/cron.js";
import { recordEvent } from "../src/results/store.js";

const DAY_MS = 86_400_000;
const at = (/** @type {number} */ minute) => Date.UTC(2026, 10, 27, 10, minute);
const EVERY_FIVE = "*/5 * * * *";
const DAILY = "41 3 * * *";
const ctx = { waitUntil() {} };

/** @param {Partial<Record<string, any>>} [overrides] */
function fakes(overrides = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const raised = [];
  const transitions = [{ target: "engage", check: "deploy-keys", status: "fail" }];
  return {
    calls,
    raised,
    transitions,
    deps: {
      retryUnnotified: async () => void calls.push("retry"),
      sweep: async (/** @type {unknown} */ _env, /** @type {string} */ by) => {
        calls.push(`sweep:${by}`);
        return { checked: 1, unknown: null, transitions };
      },
      raiseFor: async (/** @type {unknown} */ _env, /** @type {any[]} */ list) => {
        calls.push("raise");
        raised.push(...list);
        return list.length;
      },
      pruneEvents: async () => void calls.push("pruneEvents"),
      pruneAlerts: async () => void calls.push("pruneAlerts"),
      deliverPending: async () => void calls.push("deliver"),
      ...overrides,
    },
  };
}

beforeEach(async () => {
  await env.DB.batch(["alerts", "security_events", "settings"].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});
afterEach(() => vi.restoreAllMocks());

test("minute 15 sweeps and minute 20 doesn't", async () => {
  for (const minute of [0, 15, 30, 45]) {
    const { calls, deps } = fakes();
    await runScheduled(env, { cron: EVERY_FIVE, scheduledTime: at(minute) }, ctx, deps);
    expect(calls, `minute ${minute}`).toContain("sweep:sweep");
  }
  for (const minute of [5, 20, 55]) {
    const { calls, deps } = fakes();
    await runScheduled(env, { cron: EVERY_FIVE, scheduledTime: at(minute) }, ctx, deps);
    expect(calls, `minute ${minute}`).toEqual(["retry", "deliver"]);
  }
});

test("the daily run sweeps and prunes", async () => {
  const { calls, deps } = fakes();
  await runScheduled(env, { cron: DAILY, scheduledTime: Date.UTC(2026, 10, 27, 3, 41) }, ctx, deps);
  expect(calls).toEqual(["retry", "sweep:daily", "raise", "pruneEvents", "pruneAlerts", "deliver"]);
});

test("every run retries unnotified settings changes", async () => {
  for (const [cron, scheduledTime] of [
    [EVERY_FIVE, at(20)],
    [EVERY_FIVE, at(15)],
    [DAILY, at(41)],
  ]) {
    const { calls, deps } = fakes();
    await runScheduled(env, { cron: String(cron), scheduledTime: Number(scheduledTime) }, ctx, deps);
    expect(calls[0]).toBe("retry");
    expect(calls.at(-1)).toBe("deliver");
  }
});

test("a sweep that throws still delivers pending alerts", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { calls, deps } = fakes({
    sweep: async () => {
      calls.push("sweep:sweep");
      throw new Error("boom");
    },
  });
  await runScheduled(env, { cron: EVERY_FIVE, scheduledTime: at(15) }, ctx, deps);
  expect(calls).toEqual(["retry", "sweep:sweep", "deliver"]);
  expect(log).toHaveBeenCalledWith("Sweep failed", "boom");
});

test("a failing step doesn't stop the daily steps after it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { calls, deps } = fakes({
    retryUnnotified: async () => {
      throw new Error("discord down");
    },
    pruneEvents: async () => {
      throw new Error("db");
    },
  });
  await runScheduled(env, { cron: DAILY, scheduledTime: at(41) }, ctx, deps);
  expect(calls).toEqual(["sweep:daily", "raise", "pruneAlerts", "deliver"]);
});

test("a sweep's failing transitions are raised before delivery", async () => {
  const { calls, raised, transitions, deps } = fakes();
  await runScheduled(env, { cron: EVERY_FIVE, scheduledTime: at(30) }, ctx, deps);
  expect(calls).toEqual(["retry", "sweep:sweep", "raise", "deliver"]);
  expect(raised).toEqual(transitions);
});

test("the daily run prunes notified alerts", async () => {
  const now = Date.UTC(2026, 10, 27, 3, 41);
  const ago = (/** @type {number} */ days) => new Date(now - days * DAY_MS).toISOString();
  await recordEvent(env, {
    delivery: "old",
    source: "github",
    target: "engage",
    action: "x",
    actor: null,
    detail: null,
    at: ago(91),
  });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO alerts (kind, target, subject, reason, posted_at, notified) VALUES ('fail', 'a', 's', 'old', ?1, 1)",
    ).bind(ago(91)),
    env.DB.prepare(
      "INSERT INTO alerts (kind, target, subject, reason, posted_at, notified) VALUES ('fail', 'b', 's', 'new', ?1, 1)",
    ).bind(ago(89)),
  ]);
  const real = Object.fromEntries(Object.entries(fakes().deps).filter(([name]) => !name.startsWith("prune")));
  await runScheduled(env, { cron: DAILY, scheduledTime: now }, ctx, real);
  const alerts = (await env.DB.prepare("SELECT reason FROM alerts").all()).results;
  expect(alerts).toEqual([{ reason: "new" }]);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM security_events").first())?.n).toBe(0);
});
