import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { pruneEvents, recordEvent, saveResult } from "../src/results/store.js";

beforeEach(async () => {
  await env.DB.batch(["results", "security_events"].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});

/** @param {"pass" | "fail" | "unknown" | "skipped"} status @param {string} [reason] */
const result = (status, reason = "Because") => ({ status, reason, link: "https://github.com/x/y/settings" });

/** @param {"event" | "sweep" | "daily"} by @param {string} at */
const at = (by, at) => ({ target: "guardian", check: "visibility", by, at });

const row = async () =>
  await env.DB.prepare("SELECT * FROM results WHERE target = 'guardian' AND check_id = 'visibility'").first();

test("saveResult reports a first result as previous null", async () => {
  const transition = await saveResult(env, { ...at("sweep", "2026-11-27T10:00:00.000Z"), result: result("pass") });
  expect(transition).toEqual({
    target: "guardian",
    check: "visibility",
    previous: null,
    status: "pass",
    reason: "Because",
    reasonChanged: false,
    unknownSweeps: 0,
  });
  expect(await row()).toMatchObject({
    status: "pass",
    previous_status: null,
    checked_at: "2026-11-27T10:00:00.000Z",
    changed_at: "2026-11-27T10:00:00.000Z",
    changed_by: "sweep",
  });
});

test("changed_at and changed_by move only when the status changes", async () => {
  await saveResult(env, { ...at("sweep", "2026-11-27T10:00:00.000Z"), result: result("pass") });
  const same = await saveResult(env, { ...at("event", "2026-11-27T11:00:00.000Z"), result: result("pass") });
  expect(same).toMatchObject({ previous: "pass", status: "pass", reasonChanged: false });
  expect(await row()).toMatchObject({
    checked_at: "2026-11-27T11:00:00.000Z",
    changed_at: "2026-11-27T10:00:00.000Z",
    changed_by: "sweep",
  });
  const changed = await saveResult(env, { ...at("event", "2026-11-27T12:00:00.000Z"), result: result("fail") });
  expect(changed).toMatchObject({ previous: "pass", status: "fail" });
  expect(await row()).toMatchObject({
    previous_status: "pass",
    changed_at: "2026-11-27T12:00:00.000Z",
    changed_by: "event",
  });
});

test("previous_status keeps the status before the last change across a repeat", async () => {
  await saveResult(env, { ...at("sweep", "2026-11-27T10:00:00.000Z"), result: result("pass") });
  await saveResult(env, { ...at("sweep", "2026-11-27T10:15:00.000Z"), result: result("fail") });
  const repeat = await saveResult(env, { ...at("sweep", "2026-11-27T10:30:00.000Z"), result: result("fail") });
  expect(repeat.previous).toBe("fail");
  expect(await row()).toMatchObject({ status: "fail", previous_status: "pass" });
});

test("reasonChanged is true only when the status is unchanged and the reason differs", async () => {
  await saveResult(env, { ...at("sweep", "2026-11-27T10:00:00.000Z"), result: result("fail", "One") });
  const same = await saveResult(env, { ...at("sweep", "2026-11-27T10:15:00.000Z"), result: result("fail", "One") });
  expect(same.reasonChanged).toBe(false);
  const differs = await saveResult(env, { ...at("sweep", "2026-11-27T10:30:00.000Z"), result: result("fail", "Two") });
  expect(differs.reasonChanged).toBe(true);
  expect(await row()).toMatchObject({ reason: "Two" });
  const flipped = await saveResult(env, {
    ...at("sweep", "2026-11-27T10:45:00.000Z"),
    result: result("pass", "Three"),
  });
  expect(flipped.reasonChanged).toBe(false);
});

test("unknown_sweeps counts two sweeps and resets on pass", async () => {
  const first = await saveResult(env, { ...at("sweep", "2026-11-27T10:00:00.000Z"), result: result("unknown") });
  const second = await saveResult(env, { ...at("daily", "2026-11-27T10:15:00.000Z"), result: result("unknown") });
  expect([first.unknownSweeps, second.unknownSweeps]).toEqual([1, 2]);
  expect((await row())?.unknown_sweeps).toBe(2);
  const passed = await saveResult(env, { ...at("sweep", "2026-11-27T10:30:00.000Z"), result: result("pass") });
  expect(passed.unknownSweeps).toBe(0);
  expect((await row())?.unknown_sweeps).toBe(0);
});

test("an event-driven Unknown doesn't advance unknown_sweeps", async () => {
  await saveResult(env, { ...at("sweep", "2026-11-27T10:00:00.000Z"), result: result("unknown") });
  const event = await saveResult(env, { ...at("event", "2026-11-27T10:05:00.000Z"), result: result("unknown") });
  expect(event.unknownSweeps).toBe(1);
  const fromPass = await saveResult(env, {
    target: "guardian",
    check: "other",
    by: "event",
    at: "2026-11-27T10:06:00.000Z",
    result: result("unknown"),
  });
  expect(fromPass.unknownSweeps).toBe(0);
});

test("a skipped result is stored with its reason", async () => {
  await saveResult(env, { ...at("sweep", "2026-11-27T10:00:00.000Z"), result: result("skipped", "Accepted risk") });
  expect(await row()).toMatchObject({ status: "skipped", reason: "Accepted risk" });
});

const event = (/** @type {string | null} */ delivery, /** @type {string} */ when) => ({
  delivery,
  source: /** @type {const} */ ("github"),
  target: "guardian",
  action: "repository.publicized",
  actor: "raven",
  detail: "The repository became public",
  at: when,
});

test("recordEvent stores a delivery once", async () => {
  expect(await recordEvent(env, event("abc-1", "2026-11-27T10:00:00.000Z"))).toBe(true);
  expect(await recordEvent(env, event("abc-1", "2026-11-27T10:00:05.000Z"))).toBe(false);
  expect(await recordEvent(env, event("abc-2", "2026-11-27T10:00:10.000Z"))).toBe(true);
  const { results } = await env.DB.prepare(
    "SELECT delivery, detail, occurred_at FROM security_events ORDER BY id",
  ).all();
  expect(results).toEqual([
    { delivery: "abc-1", detail: "The repository became public", occurred_at: "2026-11-27T10:00:00.000Z" },
    { delivery: "abc-2", detail: "The repository became public", occurred_at: "2026-11-27T10:00:10.000Z" },
  ]);
});

test("pruneEvents keeps 89 days and drops 91", async () => {
  const now = new Date("2026-11-27T12:00:00.000Z");
  const daysAgo = (/** @type {number} */ days) => new Date(now.getTime() - days * 86_400_000).toISOString();
  await recordEvent(env, event("keep", daysAgo(89)));
  await recordEvent(env, event("drop", daysAgo(91)));
  expect(await pruneEvents(env, now)).toBe(1);
  const { results } = await env.DB.prepare("SELECT delivery FROM security_events").all();
  expect(results).toEqual([{ delivery: "keep" }]);
});
