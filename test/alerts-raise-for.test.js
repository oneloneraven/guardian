import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { raiseFor } from "../src/alerts/raise-for.js";

const standard = {
  bootstrap: "v9.9.9",
  version: 2,
  checks: [
    { group: "security", id: "deploy-keys", kind: "deploy-keys-none", scope: "repository", title: "Deploy keys" },
  ],
};

/** @param {string} text */
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

beforeEach(async () => {
  await env.DB.batch(["alerts", "standard", "settings"].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});

/** @param {Partial<import("../src/results/store.js").Transition>} changes */
const transition = changes => ({
  target: "engage",
  check: "deploy-keys",
  previous: /** @type {any} */ ("pass"),
  status: /** @type {any} */ ("fail"),
  reason: "Deploy key `ci box` added",
  reasonChanged: false,
  unknownSweeps: 0,
  ...changes,
});

async function pin() {
  const body = JSON.stringify(standard);
  const sha = await sha256(body);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO standard (version, sha256, body, verified_at) VALUES ('v9.9.9', ?1, ?2, 'now')").bind(
      sha,
      body,
    ),
    env.DB.prepare("INSERT INTO settings (key, value) VALUES ('standard', ?1)").bind(
      JSON.stringify({ version: "v9.9.9", sha256: sha }),
    ),
  ]);
}

const texts = async () =>
  (await env.DB.prepare("SELECT reason FROM alerts ORDER BY id").all()).results.map(row => row.reason);

test("raiseFor raises one alert per failing transition and names the standard's title", async () => {
  await pin();
  const raised = await raiseFor({ ...env, ADMIN_HOST: "guardian.example.test" }, [
    transition({}),
    transition({ check: "visibility", status: "pass", previous: "pass", reason: "Fine" }),
    transition({ target: "organisation", check: "record-accepted", reason: "Not accepted yet" }),
    transition({ check: "mystery", reason: "Odd" }),
  ]);
  expect(raised).toBe(3);
  expect(await texts()).toEqual([
    "engage: Deploy keys failed: Deploy key `ci box` added. https://guardian.example.test/",
    "organisation: Accepted record failed: Not accepted yet. https://guardian.example.test/",
    "engage: mystery failed: Odd. https://guardian.example.test/",
  ]);
});

test("raiseFor with no standard pinned still raises, using the check ids, and omits the link without an admin host", async () => {
  expect(await raiseFor(env, [transition({})])).toBe(1);
  expect(await texts()).toEqual(["engage: deploy-keys failed: Deploy key `ci box` added."]);
});

test("raiseFor doesn't raise the same alert twice", async () => {
  await pin();
  await raiseFor(env, [transition({})]);
  expect(await raiseFor(env, [transition({})])).toBe(0);
  expect(await texts()).toHaveLength(1);
});
