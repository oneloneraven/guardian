import { expect, test } from "vitest";
import { decide } from "../src/alerts/policy.js";

const meta = { title: "Deploy keys", adminUrl: "https://guardian.example.test/" };

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

test("a Fail from Pass or a first result raises a fail alert", () => {
  const expected = {
    kind: "fail",
    target: "engage",
    subject: "deploy-keys",
    text: "engage: Deploy keys failed: Deploy key `ci box` added. https://guardian.example.test/",
  };
  expect(decide(transition({}), meta)).toEqual(expected);
  expect(decide(transition({ previous: null }), meta)).toEqual(expected);
  expect(decide(transition({ previous: "unknown" }), meta)).toEqual(expected);
});

test("a Fail that stays Fail raises nothing unless the reason changed", () => {
  expect(decide(transition({ previous: "fail" }), meta)).toBeNull();
  expect(decide(transition({ previous: "fail", reasonChanged: true }), meta)).toMatchObject({ kind: "fail" });
});

test("a Fail that becomes Pass raises a resolved alert", () => {
  expect(decide(transition({ previous: "fail", status: "pass", reason: "No deploy keys" }), meta)).toEqual({
    kind: "resolved",
    target: "engage",
    subject: "deploy-keys",
    text: "engage: Deploy keys resolved. https://guardian.example.test/",
  });
});

test("a Fail that becomes Skipped is resolved, and other Skipped transitions raise nothing", () => {
  expect(decide(transition({ previous: "fail", status: "skipped", reason: "Accepted" }), meta)).toMatchObject({
    kind: "resolved",
  });
  expect(decide(transition({ previous: "pass", status: "skipped", reason: "Accepted" }), meta)).toBeNull();
  expect(decide(transition({ previous: "skipped", status: "pass", reason: "Fine" }), meta)).toBeNull();
  expect(decide(transition({ previous: "skipped", status: "skipped", reason: "Accepted" }), meta)).toBeNull();
});

test("an Unknown raises an alert on the second sweep only", () => {
  const unknown = { status: /** @type {const} */ ("unknown"), reason: "Couldn't read the deploy keys (HTTP 502)" };
  expect(decide(transition({ ...unknown, previous: "fail", unknownSweeps: 1 }), meta)).toBeNull();
  expect(decide(transition({ ...unknown, previous: "unknown", unknownSweeps: 2 }), meta)).toEqual({
    kind: "unknown",
    target: "engage",
    subject: "deploy-keys",
    text: "Guardian can't verify Deploy keys on engage: Couldn't read the deploy keys (HTTP 502). https://guardian.example.test/",
  });
  expect(decide(transition({ ...unknown, previous: "unknown", unknownSweeps: 3 }), meta)).toBeNull();
  expect(decide(transition({ ...unknown, previous: "unknown", unknownSweeps: 0 }), meta)).toBeNull();
});

test("a Pass that stays Pass raises nothing", () => {
  expect(decide(transition({ previous: "pass", status: "pass", reason: "Fine" }), meta)).toBeNull();
});

test("a repository seen for the first time with no expected visibility raises one alert", () => {
  const first = transition({
    target: "newcomer",
    check: "visibility",
    previous: null,
    status: "unknown",
    reason: "Expected visibility not set",
    unknownSweeps: 1,
  });
  expect(decide(first, { title: "Visibility", adminUrl: "https://guardian.example.test/" })).toEqual({
    kind: "new-repository",
    target: "newcomer",
    subject: "visibility",
    text: "New repository newcomer: set its expected visibility. https://guardian.example.test/",
  });
  const later = { ...first, previous: /** @type {const} */ ("unknown"), unknownSweeps: 2 };
  expect(decide(later, { title: "Visibility", adminUrl: "https://guardian.example.test/" })).toBeNull();
});

test("without an admin URL the text ends after the reason", () => {
  const text = decide(transition({}), { title: "Deploy keys" })?.text;
  expect(text).toBe("engage: Deploy keys failed: Deploy key `ci box` added.");
  expect(decide(transition({ previous: "fail", status: "pass" }), { title: "Deploy keys" })?.text).toBe(
    "engage: Deploy keys resolved.",
  );
});

test("no alert text contains an @", () => {
  const texts = [
    decide(transition({}), meta),
    decide(transition({ previous: "fail", status: "pass" }), meta),
    decide(
      transition({
        status: "unknown",
        previous: "unknown",
        unknownSweeps: 2,
        reason: "An email invitation is pending",
      }),
      meta,
    ),
    decide(
      transition({ check: "visibility", previous: null, status: "unknown", reason: "Expected visibility not set" }),
      meta,
    ),
    decide(transition({ target: "organisation", reason: "An email invitation is pending" }), meta),
  ].map(alert => alert?.text ?? "");
  expect(texts.every(Boolean)).toBe(true);
  for (const text of texts) expect(text).not.toContain("@");
});
