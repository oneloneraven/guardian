import { expect, test } from "vitest";
import { postDiscord } from "../src/alerts/discord.js";

const WEBHOOK = "https://discord.example.test/api/webhooks/1/token";

test("posts the text with mentions turned off and reports success on a 2xx", async () => {
  /** @type {{ url: string, init: RequestInit }[]} */
  const calls = [];
  const ok = await postDiscord({ DISCORD_WEBHOOK_URL: WEBHOOK }, "hello", async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  });
  expect(ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(WEBHOOK);
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ content: "hello", allowed_mentions: { parse: [] } });
});

test("returns false without a webhook URL and sends nothing", async () => {
  let called = false;
  const ok = await postDiscord({}, "hello", async () => {
    called = true;
    return new Response(null, { status: 204 });
  });
  expect(ok).toBe(false);
  expect(called).toBe(false);
});

test("returns false on a non-2xx", async () => {
  const ok = await postDiscord(
    { DISCORD_WEBHOOK_URL: WEBHOOK },
    "hello",
    async () => new Response("", { status: 500 }),
  );
  expect(ok).toBe(false);
});

test("returns false when fetch throws, without throwing", async () => {
  const ok = await postDiscord({ DISCORD_WEBHOOK_URL: WEBHOOK }, "hello", async () => {
    throw new Error("network down");
  });
  expect(ok).toBe(false);
});
