import { expect, test } from "vitest";
import { checkException, checkPin, checkToken, parseNames, describeChange, diffRecords } from "../src/ui/validate.js";

test("an exception needs a target, a check and a reason", () => {
  expect(checkException({ target: "", check: "", match: "", reason: "  " })).toEqual({
    target: "Name the repository, or organisation.",
    check: "Name the check, such as visibility.",
    reason: "Give a reason: every exception needs one.",
  });
  expect(checkException({ target: "engage", check: "secrets-known", match: "", reason: "Better Stack" })).toEqual({});
});

test("an exception's check is a check id", () => {
  expect(checkException({ target: "engage", check: "Secrets Known", match: "", reason: "x" })).toEqual({
    check: "Use the check's id: lower case letters, numbers and hyphens.",
  });
});

test("a known token needs an id, a name and a purpose", () => {
  expect(checkToken({ tokenId: "", name: " ", purpose: "", repository: "" })).toEqual({
    tokenId: "Give the token's id from Cloudflare.",
    name: "Give the token's name.",
    purpose: "Say what the token is for.",
  });
  expect(checkToken({ tokenId: "not an id", name: "Deploy", purpose: "Deploys", repository: "" })).toEqual({
    tokenId: "A token id is letters and numbers only.",
  });
  expect(checkToken({ tokenId: "abc123", name: "Deploy", purpose: "Deploys", repository: "" })).toEqual({});
});

test("a pin needs a version and a 64-character checksum", () => {
  expect(checkPin({ version: "1.18", sha256: "abc" })).toEqual({
    version: "Use a release tag such as v1.18.0.",
    sha256: "Paste the 64-character SHA-256 of standard.json.",
  });
  expect(checkPin({ version: "v1.18.0", sha256: "A".repeat(64) })).toEqual({});
});

test("names are read from commas, spaces or new lines", () => {
  expect(parseNames("raven, nix-2\nengage  ")).toEqual({ values: ["raven", "nix-2", "engage"] });
  expect(parseNames("   ")).toEqual({ values: [] });
  expect(parseNames("raven, not@valid")).toEqual({ error: "not@valid isn't a GitHub login or App slug." });
});

test("an audit entry reads as one plain line", () => {
  expect(describeChange({ actor: "the owner", key: "exceptions", to: null })).toBe("The owner removed an exception");
  expect(describeChange({ actor: "the owner", key: "exceptions", to: { reason: "x" } })).toBe(
    "The owner added an exception",
  );
  expect(describeChange({ actor: "the owner", key: "tokens", to: null })).toBe("The owner removed a known token");
  expect(describeChange({ actor: "the owner", key: "tokens", to: {} })).toBe("The owner added a known token");
  expect(describeChange({ actor: "the owner", key: "standard", to: { version: "v1.18.0" } })).toBe(
    "The owner pinned the standard to v1.18.0",
  );
  expect(describeChange({ actor: "another Access user", key: "owners", to: [] })).toBe(
    "Another Access user changed the owners",
  );
  expect(describeChange({ actor: "the owner", key: "apps", to: [] })).toBe("The owner changed the Apps");
  expect(
    describeChange({ actor: "the owner", key: "repositories", to: { name: "engage", expectedVisibility: "public" } }),
  ).toBe("The owner set engage's expected visibility to public");
  expect(describeChange({ actor: "the owner", key: "check-alerts", to: true })).toBe(
    "The owner turned check alerts on",
  );
  expect(describeChange({ actor: "the owner", key: "check-alerts", to: false })).toBe(
    "The owner turned check alerts off",
  );
  expect(describeChange({ actor: "the owner", key: "something-new", to: 1 })).toBe("The owner changed something-new");
});

test("a record diff lists modules added and removed, and the flags that changed", () => {
  const accepted = { modules: ["core", "web-app"], flags: { beta: false, admin: true } };
  const live = { modules: ["core", "js-toolchain"], flags: { beta: true, admin: true, d1: false } };
  expect(diffRecords(accepted, live)).toEqual({
    modules: "Modules: +js-toolchain \u2212web-app",
    flags: "Flags: beta: false \u2192 true",
  });
  expect(diffRecords(accepted, accepted)).toEqual({ modules: "Modules: no change", flags: "Flags: no change" });
  expect(diffRecords(null, { modules: ["core"], flags: { beta: true } })).toEqual({
    modules: "Modules: +core",
    flags: "Flags: beta: false \u2192 true",
  });
});
