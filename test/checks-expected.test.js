import { expect, test } from "vitest";
import recordBare from "./fixtures/record-bare.json?raw";
import recordGuardian from "./fixtures/record-guardian.json?raw";
import standardText from "./fixtures/standard-v1.18.0.json?raw";
import { expectedFor, parseRecord, RecordError, whenHolds } from "../src/checks/expected.js";

const standard = JSON.parse(standardText);
const guardian = parseRecord(recordGuardian);
const bare = parseRecord(recordBare);

/** @param {Partial<Parameters<typeof expectedFor>[0]>} [overrides] */
const expected = overrides =>
  expectedFor({
    standard,
    record: guardian,
    repo: "guardian",
    owner: "oneloneraven",
    visibility: "public",
    plan: "free",
    ...overrides,
  });

test("guardian's record expects production with refs branch:main and tag:v*, and no beta environment", () => {
  const { environments } = expected();
  expect(environments.map(environment => environment.name)).toEqual(["infra", "production"]);
  expect(environments.find(environment => environment.name === "production")?.refs).toEqual(["branch:main", "tag:v*"]);
  expect(environments.find(environment => environment.name === "infra")?.refs).toEqual(["branch:main"]);
});

test("an object ref is dropped when its flags don't hold", () => {
  const record = { ...guardian, flags: { ...guardian.flags, admin: false } };
  const production = expected({ record }).environments.find(environment => environment.name === "production");
  expect(production?.refs).toEqual(["tag:v*"]);
});

test("guardian's record expects its secrets by scope", () => {
  const result = expected();
  expect(result.repositorySecrets).toContain("CLOUDFLARE_PREVIEW_TOKEN");
  expect(result.repositorySecrets).toContain("BOARD_SYNC_APP_PRIVATE_KEY");
  expect(result.repositorySecrets).not.toContain("PROJECT_STATUS_PAT");
  expect(result.environmentSecrets.production).toEqual(["CLOUDFLARE_DEPLOY_TOKEN", "OWNER_EMAIL"]);
  expect(result.environmentSecrets.beta).toBeUndefined();
});

test("a skipped environment step moves its secrets to repository level", () => {
  const record = { ...guardian, skipped: { "github:cloudflare-opentofu:1": "No GitHub environment" } };
  const result = expected({ record });
  expect(result.environments.map(environment => environment.name)).toEqual(["infra"]);
  expect(result.environmentSecrets.production).toBeUndefined();
  expect(result.repositorySecrets).toEqual(expect.arrayContaining(["CLOUDFLARE_DEPLOY_TOKEN", "OWNER_EMAIL"]));
});

test("whenHolds treats an array as any-of and !key as falsy", () => {
  const flags = { a: true, b: false };
  expect(whenHolds(undefined, flags)).toBe(true);
  expect(whenHolds("a", flags)).toBe(true);
  expect(whenHolds("b", flags)).toBe(false);
  expect(whenHolds("missing", flags)).toBe(false);
  expect(whenHolds("!b", flags)).toBe(true);
  expect(whenHolds("!a", flags)).toBe(false);
  expect(whenHolds("!missing", flags)).toBe(true);
  expect(whenHolds(["b", "a"], flags)).toBe(true);
  expect(whenHolds(["b", "missing"], flags)).toBe(false);
  expect(whenHolds(["b", "!b"], flags)).toBe(true);
});

test("no record expects no environments, no secrets and the core apps only when core is a module", () => {
  const none = expected({ record: null });
  expect(none.environments).toEqual([]);
  expect(none.repositorySecrets).toEqual([]);
  expect(none.environmentSecrets).toEqual({});
  expect(none.apps).toEqual([]);
  expect(expected({ record: bare }).apps).toEqual(["guardian-release"]);
});

test("security features follow the visibility", () => {
  expect(expected({ visibility: "private" }).securityFeatures).toEqual([]);
  expect(expected({ visibility: "public" }).securityFeatures).toContain("private_vulnerability_reporting");
  expect(expected().actionsPermissions).toEqual(standard.expected.actionsPermissions);
});

test("the ruleset isn't expected on a private repository on the free plan", () => {
  expect(expected({ visibility: "private", plan: "free" }).ruleset).toEqual({
    name: "default-branch-protection",
    expected: false,
  });
  expect(expected({ visibility: "private", plan: "team" }).ruleset.expected).toBe(true);
  expect(expected({ visibility: "public", plan: "free" }).ruleset.expected).toBe(true);
});

test("parseRecord ignores exceptions and refuses version 2", () => {
  const parsed = parseRecord(
    JSON.stringify({
      version: 1,
      modules: ["core"],
      visibility: "private",
      flags: { beta: true },
      skipped: { "manual:core:1": "why" },
      exceptions: [{ match: "SECRET", reason: "sneaky" }],
    }),
  );
  expect(parsed).toEqual({ modules: ["core"], flags: { beta: true }, skipped: { "manual:core:1": "why" } });
  expect(() => parseRecord(JSON.stringify({ version: 2, modules: [] }))).toThrow(RecordError);
  expect(() => parseRecord("{nope")).toThrow(RecordError);
  expect(() => parseRecord(JSON.stringify({ version: 1, modules: "core" }))).toThrow(RecordError);
});
