import { $, $$, browser, expect } from "@wdio/globals";

const SETTINGS = {
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

const browserName = () => String(browser.capabilities.browserName);
// Chrome doesn't match a "**/" glob against the path, so mocks name the full URL.
const api = path => new URL(path, browser.options.baseUrl).href;

async function mockSettings(body = SETTINGS) {
  const mock = await browser.mock(api("/api/settings"), { method: "get" });
  await mock.respond(body, { headers: { "Content-Type": "application/json" } });
  return mock;
}

afterEach(async () => {
  await browser.mockRestoreAll();
});

describe("admin page", () => {
  it("renders every section from the settings", async () => {
    await mockSettings();
    await browser.url("/");
    await $("#standard").waitForExist();
    const titles = await $$("section h2").map(title => title.getText());
    expect(titles).toEqual([
      "Standard",
      "Alerts",
      "Owners and Apps",
      "Repositories",
      "Exceptions",
      "Known tokens",
      "Settings audit",
      "Results",
      "Security events",
    ]);
    await expect($("#standard .state")).toHaveText("Pinned to v1.18.0.");
    await expect($("#owners-values")).toHaveValue("raven");
    await expect($("#apps-values")).toHaveValue("engage, guardian");
    await expect($('li[data-repository="new-thing"]')).toHaveText(
      expect.stringContaining("Expected visibility not set"),
    );
    await expect($('li[data-exception="1"]')).toHaveText(expect.stringContaining("Better Stack sends uptime pings"));
    await expect($('li[data-token="abc123"]')).toHaveText(expect.stringContaining("Deploys Engage"));
    await expect($('li[data-audit="2"]')).toHaveText(expect.stringContaining("The owner added an exception"));
    await expect($('li[data-audit="2"]')).toHaveText(expect.stringContaining("Not announced on Discord yet"));
    await expect($("#results .empty")).toHaveText("Not watching yet.");
  });

  it("the alerts switch shows its state and saves", async () => {
    await mockSettings();
    await browser.url("/");
    await $("#alerts").waitForExist();
    await expect($("#alerts .state")).toHaveText(
      "Check alerts are off. Results are still recorded, and settings changes are always announced.",
    );
    const put = await browser.mock(api("/api/alerts"), { method: "put" });
    await put.respond({ ok: true });
    await mockSettings({ ...SETTINGS, alerts: { enabled: true } });
    await $("button=Turn check alerts on").click();
    await expect($("#alerts .saved")).toHaveText("Check alerts turned on.");
    await expect($("#alerts .state")).toHaveText(
      "Check alerts are on: failures, resolutions and things Guardian can't verify post to Discord.",
    );
    expect(put.calls).toHaveLength(1);
    expect(put.calls[0].postData).toBe(JSON.stringify({ enabled: true }));

    await $("button=Turn check alerts off").click();
    await expect($("button=Turn them off")).toBeExisting();
    await $("button=Keep them on").click();
    await expect($("button=Turn check alerts off")).toBeExisting();
    expect(put.calls).toHaveLength(1);
  });

  it("says why the pinned standard isn't in use", async () => {
    await mockSettings({ ...SETTINGS, standard: { version: "v1.18.0", unknown: "Pinned standard missing" } });
    await browser.url("/");
    await $("#standard").waitForExist();
    await expect($("#standard .state")).toHaveText("v1.18.0 isn't in use: Pinned standard missing.");
  });

  it("shows the field error for an exception with no reason, and sends nothing", async () => {
    await mockSettings();
    const post = await browser.mock(api("/api/exceptions"), { method: "post" });
    await post.respond({ ok: true }, { statusCode: 201 });
    await browser.url("/");
    await $("#standard").waitForExist();
    await $("#exception-target").setValue("engage");
    await $("#exception-check").setValue("visibility");
    await $("button=Add exception").click();
    await expect($("#exception-reason-error")).toHaveText("Give a reason: every exception needs one.");
    await expect($("#exception-reason")).toHaveAttribute("aria-invalid", "true");
    await expect($("#exception-reason")).toBeFocused();
    expect(post.calls).toHaveLength(0);
  });

  it("shows the refusal reason when re-pinning is refused", async () => {
    await mockSettings();
    const reason = `Checksum mismatch: expected ${"0".repeat(64)}, got ${"1".repeat(64)}`;
    const post = await browser.mock(api("/api/standard"), { method: "post" });
    await post.respond({ error: reason }, { statusCode: 422 });
    await browser.url("/");
    await $("#standard").waitForExist();
    await $("#pin-version").setValue("v1.18.0");
    await $("#pin-sha256").setValue("0".repeat(64));
    await $("button=Pin this standard").click();
    await expect($("#pin .form-error")).toHaveText(reason);
  });

  it("adds and removes an exception against the real API, auditing both", async () => {
    const target = `e2e-${browserName()}`;
    await browser.url("/");
    await $("#standard").waitForExist();
    await browser.execute(async leftover => {
      const { exceptions } = await (await fetch("/api/settings")).json();
      for (const exception of exceptions.filter(e => e.target === leftover)) {
        await fetch(`/api/exceptions/${exception.id}`, { method: "DELETE" });
      }
    }, target);
    await browser.refresh();
    await $("#standard").waitForExist();
    await $("#exception-target").setValue(target);
    await $("#exception-check").setValue("visibility");
    await $("#exception-reason").setValue("Checked by the e2e suite");
    await $("button=Add exception").click();
    await expect($("#exceptions .saved")).toHaveText("Exception added.");
    const row = $(`li[data-exception]*=visibility on ${target}`);
    await expect(row).toBeExisting();

    await row.$("button=Remove").click();
    await row.$("button=Remove for good").click();
    await expect($("#exceptions .saved")).toHaveText("Exception removed.");
    await expect($(`li[data-exception]*=visibility on ${target}`)).not.toBeExisting();
    await expect($("#audit .rows")).toHaveText(expect.stringContaining("The owner removed an exception"));
  });
});
