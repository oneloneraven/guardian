import { expect, test } from "vitest";
import { classify } from "../src/cloudflare/actions.js";

/** @param {Partial<import("../src/cloudflare/audit.js").AuditEntry>} over */
const entry = over => ({
  id: "e1",
  time: "2026-11-28T12:00:00.000Z",
  actorType: "user",
  actorContext: "dashboard",
  tokenId: "",
  tokenName: "",
  actionType: "update",
  actionResult: "success",
  description: "A change",
  product: "",
  resourceType: "",
  resourceId: "res-1",
  resourceScope: "accounts",
  ...over,
});

const known = [
  { tokenId: "t-deploy", name: "guardian deploy", purpose: "Deploy Guardian", repository: "guardian" },
  { tokenId: "t-infra", name: "infra", purpose: "Guardian infra apply", repository: null },
  { tokenId: "t-coraxia", name: "coraxia", purpose: "Coraxia infra apply", repository: null },
];
const run = (/** @type {any} */ over, /** @type {string} */ coraxia = "t-coraxia") =>
  classify(entry(over), known, coraxia);

test("API token changes alert", () => {
  for (const actionType of ["create", "update", "delete"]) {
    const result = run({ product: "api_tokens", resourceType: "token", actionType });
    expect(result.level).toBe("alert");
    expect(result.text).toMatch(/^`a dashboard user` /);
  }
  expect(run({ product: "api_tokens", resourceType: "token", actionType: "create" }).text).toBe(
    "`a dashboard user` created API token `res-1`",
  );
});

test("Access changes alert, whatever the resource", () => {
  for (const resourceType of ["application", "policy", "identity_provider", "organization", "service_token", "group"]) {
    expect(run({ product: "Zero Trust Access", resourceType }).level, resourceType).toBe("alert");
  }
  expect(run({ product: "access", resourceType: "application" }).level).toBe("alert");
});

test("Turnstile widget changes alert", () => {
  for (const actionType of ["create", "delete", "update"]) {
    expect(run({ product: "turnstile", resourceType: "widget", actionType }).level).toBe("alert");
  }
});

test("members, roles and invites alert", () => {
  for (const [product, resourceType] of [
    ["members", "member"],
    ["members", "role"],
    ["account", "invite"],
  ]) {
    expect(run({ product, resourceType }).level, `${product}/${resourceType}`).toBe("alert");
  }
});

test("account settings alert", () => {
  expect(run({ product: "account", resourceType: "settings" }).level).toBe("alert");
});

test("a D1 database delete alerts", () => {
  const result = run({ product: "d1", resourceType: "database", actionType: "delete" });
  expect(result).toEqual({ level: "alert", text: "`a dashboard user` deleted D1 database `res-1`" });
});

test("a D1 Time Travel restore alerts", () => {
  const result = run({
    product: "d1",
    resourceType: "time_travel",
    actionType: "update",
    description: "Restore database",
  });
  expect(result.level).toBe("alert");
  expect(result.text).toContain("restore");
});

test("D1 queries are routine", () => {
  expect(run({ product: "d1", resourceType: "query", actionType: "create", tokenId: "t-deploy" }).level).toBe("record");
});

test("KV, R2 and Cache reads are routine, and their changes alert", () => {
  for (const product of ["workers_kv", "r2", "cache"]) {
    expect(run({ product, resourceType: "x", actionType: "view" }).level, product).toBe("record");
    expect(run({ product, resourceType: "x", actionType: "delete" }).level, product).toBe("alert");
  }
});

test("a Worker deploy by its own repository's token is routine", () => {
  for (const script of ["guardian", "guardian-production"]) {
    const result = run({ product: "workers", resourceType: "script", tokenId: "t-deploy", resourceId: script });
    expect(result.level, script).toBe("record");
  }
});

test("a deploy token deploying another repository's Worker alerts", () => {
  const result = run({
    product: "workers",
    resourceType: "script",
    tokenId: "t-deploy",
    resourceId: "guardianship-prod",
    tokenName: "guardian deploy",
  });
  expect(result).toEqual({ level: "alert", text: "`guardian deploy` deployed Worker `guardianship-prod`" });
  expect(
    run({ product: "workers", resourceType: "script", tokenId: "t-deploy", resourceId: "coraxia-prod" }).level,
  ).toBe("alert");
});

test("a Worker deploy by an unknown token or a dashboard user alerts", () => {
  expect(run({ product: "workers", resourceType: "script", tokenId: "t-other", resourceId: "guardian" }).level).toBe(
    "alert",
  );
  expect(run({ product: "workers", resourceType: "script", resourceId: "guardian" }).text).toBe(
    "`a dashboard user` deployed Worker `guardian`",
  );
});

test("Worker secrets and settings follow the same rule", () => {
  const own = { tokenId: "t-deploy", resourceId: "guardian-production" };
  expect(run({ product: "workers", resourceType: "secret", ...own }).level).toBe("record");
  expect(run({ product: "workers", resourceType: "setting", ...own }).level).toBe("record");
  expect(run({ product: "workers", resourceType: "secret", resourceId: "guardian" }).text).toBe(
    "`a dashboard user` changed secrets of Worker `guardian`",
  );
  expect(run({ product: "workers", resourceType: "settings", resourceId: "guardian" }).text).toBe(
    "`a dashboard user` changed settings of Worker `guardian`",
  );
});

test("Worker routes by a repository's token are routine, and by anyone else alert", () => {
  expect(run({ product: "workers", resourceType: "route", tokenId: "t-deploy" }).level).toBe("record");
  expect(run({ product: "workers", resourceType: "route" }).level).toBe("alert");
});

test("DNS changes by an infra token are routine, and by anyone else alert", () => {
  expect(run({ product: "dns", resourceType: "record", tokenId: "t-infra" }).level).toBe("record");
  expect(run({ product: "dns", resourceType: "record", tokenId: "t-deploy" }).level).toBe("alert");
  expect(run({ product: "dns", resourceType: "record" }).level).toBe("alert");
});

test("an unrecognised action alerts naming it", () => {
  expect(run({ product: "magic_transit", resourceType: "tunnel", actionType: "create" })).toEqual({
    level: "alert",
    text: "Unrecognised Cloudflare action `create` on `magic_transit`/`tunnel`",
  });
});

test('a dashboard change shows "a dashboard user"', () => {
  const result = run({ product: "members", resourceType: "member", actorType: "user", tokenId: "", tokenName: "" });
  expect(result.text.startsWith("`a dashboard user` ")).toBe(true);
  expect(result.text).not.toContain("@");
});

test("Coraxia's apply token changing Access is info", () => {
  const result = run({
    product: "access",
    resourceType: "application",
    tokenId: "t-coraxia",
    description: "Update app",
  });
  expect(result).toEqual({ level: "info", text: "Coraxia changed access `res-1`: Update app" });
  expect(run({ product: "turnstile", resourceType: "widget", tokenId: "t-coraxia" }).level).toBe("info");
  expect(run({ product: "access", resourceType: "application", tokenId: "t-coraxia" }, "").level).toBe("alert");
  expect(run({ product: "api_tokens", resourceType: "token", tokenId: "t-coraxia" }).level).toBe("alert");
});

test("a failure on an alerting row says it tried to", () => {
  const result = run({ product: "api_tokens", resourceType: "token", actionType: "create", actionResult: "failure" });
  expect(result).toEqual({ level: "alert", text: "`a dashboard user` tried to create API token `res-1`" });
  const deploy = run({
    product: "workers",
    resourceType: "script",
    tokenId: "t-deploy",
    resourceId: "guardian",
    actionResult: "failure",
  });
  expect(deploy).toEqual({ level: "alert", text: "`a user API token` tried to deploy Worker `guardian`" });
  expect(run({ product: "access", resourceType: "policy", tokenId: "t-coraxia", actionResult: "failure" }).level).toBe(
    "alert",
  );
});

test("a tokens product alerts as an API token, even with no resource type", () => {
  const result = run({ product: "tokens", resourceType: "", actionType: "create", description: "Create Token" });
  expect(result).toEqual({ level: "alert", text: "`a dashboard user` created API token `res-1`" });
  expect(
    run({ product: "account", resourceType: "settings", actionType: "create", description: "TOKEN_CREATE" }).level,
  ).toBe("alert");
});

test("D1 queries are routine whatever the actor, however they are logged", () => {
  const shape = {
    product: "d1",
    resourceType: "database.query",
    actionType: "create",
    description: "Query D1 Database",
  };
  expect(run({ ...shape, actorType: "account", tokenId: "t-other" }).level).toBe("record");
  expect(run(shape).level).toBe("record");
  expect(run({ ...shape, resourceType: "database", resourceId: "db" }).level).toBe("record");
  expect(run({ ...shape, actionResult: "failure" }).level).toBe("alert");
  expect(
    run({ product: "d1", resourceType: "database", actionType: "create", description: "Create D1 Database" }).level,
  ).toBe("alert");
});

test("a Worker's preview, assets upload and subdomain work is routine for its own repository's token only", () => {
  const types = [
    ["scripts.subdomain", "guardian-production", "Update Worker Script Subdomain"],
    ["workers.previews.deployments", "guardian-preview", "Create Preview Deployment"],
    ["scripts.assets-upload-session", "guardian-production", "Create Worker Assets Upload Session"],
    ["workers.previews", "guardian-preview", "Edit Preview"],
  ];
  for (const [resourceType, resourceId, description] of types) {
    const shape = { product: "workers", resourceType, resourceId, description, actionType: "create" };
    expect(run({ ...shape, tokenId: "t-deploy" }).level, resourceType).toBe("record");
    expect(run({ ...shape, tokenId: "t-infra" }).level, resourceType).toBe("alert");
    expect(run({ ...shape, tokenId: "t-deploy", resourceId: "coraxia-preview" }).level, resourceType).toBe("alert");
    expect(run(shape).level, resourceType).toBe("alert");
  }
});
