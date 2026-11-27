import { expect, test } from "vitest";
import { summarise } from "../src/github/events.js";

const repository = { name: "engage", default_branch: "main" };
const sender = { login: "mallory" };

test("a deploy key created is summarised with the sender and the key's title", () => {
  expect(summarise("deploy_key", { action: "created", sender, repository, key: { title: "ci box" } })).toEqual({
    target: "engage",
    action: "deploy_key.created",
    actor: "mallory",
    detail: "`mallory` added deploy key `ci box`",
    scope: "repository",
  });
  expect(summarise("deploy_key", { action: "deleted", sender, repository, key: { title: "ci box" } })?.detail).toBe(
    "`mallory` removed deploy key `ci box`",
  );
});

test("a repository made public or private says so", () => {
  expect(summarise("repository", { action: "publicized", sender, repository })?.detail).toBe(
    "`mallory` made the repository public",
  );
  expect(summarise("repository", { action: "privatized", sender, repository })?.detail).toBe(
    "`mallory` made the repository private",
  );
});

test("a collaborator added names the member", () => {
  expect(summarise("member", { action: "added", sender, repository, member: { login: "eve" } })).toMatchObject({
    detail: "`mallory` added collaborator `eve`",
    scope: "repository",
  });
});

test("an organisation invitation names the login, or an email address without naming it", () => {
  const byLogin = summarise("organization", { action: "member_invited", sender, invitation: { login: "eve" } });
  expect(byLogin).toMatchObject({ target: "organisation", scope: "organisation", detail: "`mallory` invited `eve`" });
  const byEmail = summarise("organization", {
    action: "member_invited",
    sender,
    invitation: { login: null, email: "eve@example.test" },
  });
  expect(byEmail?.detail).toBe("`mallory` invited an email address");
  expect(JSON.stringify(byEmail)).not.toContain("example.test");
});

test("a ruleset edited or deleted names the ruleset", () => {
  const ruleset = { name: "default-branch-protection" };
  expect(
    summarise("repository_ruleset", { action: "edited", sender, repository, repository_ruleset: ruleset })?.detail,
  ).toBe("`mallory` changed ruleset `default-branch-protection`");
  expect(
    summarise("repository_ruleset", { action: "deleted", sender, repository, repository_ruleset: ruleset })?.detail,
  ).toBe("`mallory` deleted ruleset `default-branch-protection`");
});

const push = (/** @type {string} */ ref, /** @type {object[]} */ commits) => ({ ref, sender, repository, commits });

test("a push summarises only when it touches the record on the default branch", () => {
  const touching = summarise(
    "push",
    push("refs/heads/main", [{ added: [], modified: [".bootstrap/record.json"], removed: [] }]),
  );
  expect(touching).toMatchObject({
    target: "engage",
    action: "push",
    detail: "`mallory` changed `.bootstrap/record.json`",
    scope: "repository",
  });
  expect(
    summarise("push", push("refs/heads/main", [{ added: [], modified: [], removed: [".bootstrap/record.json"] }])),
  ).not.toBeNull();
  expect(summarise("push", push("refs/heads/main", [{ added: ["a.js"], modified: ["b.js"], removed: [] }]))).toBeNull();
  expect(
    summarise("push", push("refs/heads/feature", [{ added: [], modified: [".bootstrap/record.json"], removed: [] }])),
  ).toBeNull();
});

test("ping and events Guardian doesn't watch are null", () => {
  expect(summarise("ping", { zen: "Keep it logically awesome." })).toBeNull();
  expect(summarise("issues", { action: "opened", sender, repository })).toBeNull();
});

test("other actions of a watched event get a generic line", () => {
  expect(summarise("repository", { action: "archived", sender, repository })?.detail).toBe(
    "`mallory`: repository archived",
  );
  expect(summarise("security_and_analysis", { sender, repository })?.detail).toBe("`mallory`: security_and_analysis");
});

test("installation events are organisation scope, and installation_repositories too", () => {
  expect(summarise("installation", { action: "created", sender })).toMatchObject({
    target: "organisation",
    scope: "organisation",
  });
  expect(summarise("installation_repositories", { action: "added", sender })).toMatchObject({
    target: "organisation",
    scope: "organisation",
  });
});

test("a summary never carries an @ or a backtick from user-supplied text", () => {
  const summary = summarise("deploy_key", {
    action: "created",
    sender,
    repository,
    key: { title: "me@example.test `x`" },
  });
  expect(summary?.detail).not.toContain("@");
  expect(summary?.detail).toBe("`mallory` added deploy key `me example.test 'x'`");
});

test("a missing sender gives a null actor and a plain line", () => {
  const summary = summarise("repository", { action: "publicized", repository });
  expect(summary).toMatchObject({ actor: null, detail: "Someone made the repository public" });
});
