import { browser } from "@wdio/globals";

export const SETTINGS = {
  standard: { version: "v1.18.0" },
  owners: ["raven"],
  apps: ["engage", "guardian"],
  alerts: { enabled: false },
  repositories: [
    { name: "engage", expectedVisibility: "public", acceptedRecordSha: null },
    { name: "new-thing", expectedVisibility: null, acceptedRecordSha: null },
  ],
  exceptions: [
    {
      id: 1,
      target: "engage",
      check: "secrets-known",
      match: "BETTER_STACK_TOKEN",
      reason: "Better Stack sends uptime pings",
      createdAt: "2026-11-27T10:00:00.000Z",
    },
  ],
  tokens: [{ tokenId: "abc123", name: "Engage Deploy", purpose: "Deploys Engage", repository: "engage" }],
  audit: [
    {
      id: 2,
      actor: "the owner",
      key: "exceptions",
      from: null,
      to: { reason: "x" },
      changedAt: "2026-11-27T10:00:00.000Z",
      notified: false,
    },
  ],
};

export const RESULTS = [
  {
    target: "engage",
    check: "deploy-keys",
    title: "Deploy keys",
    status: "fail",
    reason: "Deploy key `ci box` added",
    link: "https://github.com/oneloneraven/engage/settings/keys",
    checkedAt: "2026-11-27T10:15:00.000Z",
  },
  {
    target: "organisation",
    check: "org-2fa",
    title: "Organisation two-factor",
    status: "unknown",
    reason: "GitHub didn't show whether two-factor is required",
    link: null,
    checkedAt: "2026-11-27T10:15:00.000Z",
  },
  {
    target: "engage",
    check: "webhooks",
    title: "Webhooks",
    status: "skipped",
    reason: "Uptime pings",
    link: null,
    checkedAt: "2026-11-27T10:15:00.000Z",
  },
  {
    target: "engage",
    check: "visibility",
    title: "Visibility",
    status: "pass",
    reason: "The repository is public",
    link: "https://github.com/oneloneraven/engage/settings",
    checkedAt: "2026-11-27T10:15:00.000Z",
  },
  {
    target: "engage",
    check: "secrets-known",
    title: "Known secrets only",
    status: "pass",
    reason: "Every secret is expected",
    link: null,
    checkedAt: "2026-11-27T10:15:00.000Z",
  },
];

export const EVENTS = [
  {
    target: "engage",
    action: "deploy_key.created",
    actor: "mallory",
    detail: "`mallory` added deploy key `ci box`",
    at: "2026-11-27T10:14:00.000Z",
  },
  {
    target: "organisation",
    action: "organization.member_invited",
    actor: "raven",
    detail: "`raven` invited an email address",
    at: "2026-11-27T09:00:00.000Z",
  },
];

export const RECORDS = {
  accepted: { sha: "a".repeat(40), modules: ["core", "web-app"], flags: { beta: false } },
  live: { sha: "b".repeat(40), modules: ["core", "js-toolchain"], flags: { beta: true } },
};

export const browserName = () => String(browser.capabilities.browserName);
// Chrome does not match a "**/" glob against the path, so mocks name the full URL.
export const api = path => new URL(path, browser.options.baseUrl).href;

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Mocks every read the page makes on load.
 * @param {{ settings?: object, results?: object[], events?: object[] }} [options]
 */
export async function mockPage({ settings = SETTINGS, results = RESULTS, events = EVENTS } = {}) {
  for (const [path, body] of [
    ["/api/settings", settings],
    ["/api/results", { results }],
    ["/api/events", { events }],
  ]) {
    const mock = await browser.mock(api(path), { method: "get" });
    await mock.respond(body, { statusCode: 200, headers: JSON_HEADERS });
  }
}
