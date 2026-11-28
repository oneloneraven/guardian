import { expect, test } from "vitest";
import { pingHeartbeat } from "../src/heartbeat.js";

const env = { BETTER_STACK_HEARTBEAT_URL: "https://heartbeat.example.test/ping/abc" };

test("pings at the end of every run", async () => {
  /** @type {string[]} */
  const urls = [];
  const fetchImpl = /** @type {typeof fetch} */ (
    async (/** @type {any} */ url) => {
      urls.push(String(url));
      return new Response(null, { status: 200 });
    }
  );
  expect(await pingHeartbeat(env, fetchImpl)).toBe(true);
  expect(urls).toEqual([env.BETTER_STACK_HEARTBEAT_URL]);
});

test("a failing or hanging ping doesn't fail the run", async () => {
  const failing = /** @type {typeof fetch} */ (
    async () => {
      throw new Error("down");
    }
  );
  expect(await pingHeartbeat(env, failing)).toBe(false);
  const rejected = /** @type {typeof fetch} */ (async () => new Response(null, { status: 500 }));
  expect(await pingHeartbeat(env, rejected)).toBe(false);
  const hanging = /** @type {typeof fetch} */ (
    (/** @type {any} */ _url, /** @type {any} */ init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      })
  );
  expect(await pingHeartbeat(env, hanging, 20)).toBe(false);
});

test("no URL, no ping", async () => {
  let called = false;
  const fetchImpl = /** @type {typeof fetch} */ (
    async () => {
      called = true;
      return new Response(null, { status: 200 });
    }
  );
  expect(await pingHeartbeat({}, fetchImpl)).toBe(false);
  expect(called).toBe(false);
});
