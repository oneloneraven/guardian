import { expect, test } from "vitest";
import worker from "../src/worker.js";

const env = { APP_ENV: "test", RELEASE_VERSION: "v1.2.3", ASSETS: { fetch: async () => new Response("asset") } };
const admin = { ...env, APP_ENV: "e2e", ADMIN_ACCESS_CHECK: "off", ADMIN_HOST: "admin.example.test" };

test("health reports the environment and release", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/health"), env);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true, environment: "test", version: "v1.2.3" });
});

test("the API host doesn't serve the admin page", async () => {
  const response = await worker.fetch(new Request("https://example.test/"), env);
  expect(response.status).toBe(404);
});

test("the admin host answers 404 to anyone the owner check refuses", async () => {
  const refused = { ...admin, APP_ENV: "production", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
  const response = await worker.fetch(new Request("https://admin.example.test/"), refused);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("the admin host serves the page to a request the owner check accepts", async () => {
  const response = await worker.fetch(new Request("https://admin.example.test/"), admin);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("asset");
});

test("without an admin host configured, no request is treated as admin", async () => {
  const response = await worker.fetch(new Request("https://admin.example.test/"), {
    ...env,
    ADMIN_ACCESS_CHECK: "off",
  });
  expect(response.status).toBe(404);
});

test("the API host never serves /api, other than health", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/settings"), admin);
  expect(response.status).toBe(404);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("the admin host refuses /api to anyone the owner check refuses", async () => {
  const refused = { ...admin, APP_ENV: "production", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
  const response = await worker.fetch(new Request("https://admin.example.test/api/settings"), refused);
  expect(response.status).toBe(404);
});

test("the API host hands POST /v1/github/webhook to the webhook, which refuses an unsigned body", async () => {
  const webhook = { ...env, GITHUB_WEBHOOK_SECRET: "secret", ADMIN_HOST: "admin.example.test" };
  const request = () => new Request("https://example.test/v1/github/webhook", { method: "POST", body: "{}" });
  expect((await worker.fetch(request(), webhook, { waitUntil() {} })).status).toBe(401);
  const get = await worker.fetch(new Request("https://example.test/v1/github/webhook"), webhook, { waitUntil() {} });
  expect(get.status).toBe(404);
});

test("the admin host doesn't serve the webhook", async () => {
  const webhook = { ...admin, GITHUB_WEBHOOK_SECRET: "secret" };
  const request = () => new Request("https://admin.example.test/v1/github/webhook", { method: "POST", body: "{}" });
  const accepted = await worker.fetch(request(), webhook, { waitUntil() {} });
  expect(await accepted.text()).toBe("asset");
  const refused = { ...webhook, APP_ENV: "production", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
  expect((await worker.fetch(request(), refused, { waitUntil() {} })).status).toBe(404);
});
