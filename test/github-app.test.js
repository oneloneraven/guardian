import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { appJwt, clearInstallationToken, GithubUnavailable, installationToken } from "../src/github/app.js";

/** @param {Uint8Array} bytes */
function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

/** @param {string} value */
function fromBase64url(value) {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function generatePair() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const lines = toBase64(der).match(/.{1,64}/g) ?? [];
  return {
    publicKey: pair.publicKey,
    pem: `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`,
  };
}

const { pem } = await generatePair();
const ENV = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_ORG: "oneloneraven" };

beforeEach(() => clearInstallationToken());
afterEach(() => vi.useRealTimers());

test("appJwt signs a token GitHub can verify", async () => {
  const { publicKey, pem: keyPem } = await generatePair();
  const jwt = await appJwt("98765", keyPem, 1_800_000_000);
  const [header, claims, signature] = jwt.split(".");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    fromBase64url(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  expect(valid).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(fromBase64url(header)))).toEqual({ alg: "RS256", typ: "JWT" });
  expect(JSON.parse(new TextDecoder().decode(fromBase64url(claims)))).toEqual({
    iss: "98765",
    iat: 1_800_000_000 - 60,
    exp: 1_800_000_000 + 540,
  });
});

/** @param {string} expiresAt */
function stubGithub(expiresAt) {
  /** @type {string[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/orgs/oneloneraven/installation")) return Response.json({ id: 42 });
    return Response.json({ token: `token-${calls.length}`, expires_at: expiresAt }, { status: 201 });
  };
  return { calls, fetchImpl };
}

test("installationToken caches until 5 minutes before expiry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  const { calls, fetchImpl } = stubGithub(new Date(start + 60 * 60 * 1000).toISOString());

  const first = await installationToken(ENV, fetchImpl);
  expect(calls).toEqual([
    "GET https://api.github.com/orgs/oneloneraven/installation",
    "POST https://api.github.com/app/installations/42/access_tokens",
  ]);

  vi.setSystemTime(start + 54 * 60 * 1000);
  expect(await installationToken(ENV, fetchImpl)).toBe(first);
  expect(calls).toHaveLength(2);

  vi.setSystemTime(start + 55 * 60 * 1000 + 1);
  const second = await installationToken(ENV, fetchImpl);
  expect(calls).toHaveLength(4);
  expect(second).not.toBe(first);
});

test("installationToken throws GithubUnavailable without an App id or key", async () => {
  const fetchImpl = vi.fn();
  for (const env of [
    {},
    { ...ENV, GITHUB_APP_ID: "" },
    { ...ENV, GITHUB_APP_PRIVATE_KEY: "" },
    { ...ENV, GITHUB_ORG: "" },
  ]) {
    await expect(installationToken(env, fetchImpl)).rejects.toBeInstanceOf(GithubUnavailable);
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("installationToken throws GithubUnavailable when GitHub refuses the token", async () => {
  /** @type {typeof fetch} */
  const refuse = async url =>
    String(url).endsWith("/installation") ? Response.json({ id: 42 }) : new Response("no", { status: 401 });
  await expect(installationToken(ENV, refuse)).rejects.toBeInstanceOf(GithubUnavailable);
  /** @type {typeof fetch} */
  const noInstall = async () => new Response("no", { status: 404 });
  await expect(installationToken(ENV, noInstall)).rejects.toBeInstanceOf(GithubUnavailable);
});
