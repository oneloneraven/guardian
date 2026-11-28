import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminIdentity, clearAccessKeyCache, serviceIdentity, verifyAccessJwt } from "../../src/lib/access.js";

const TEAM = "example.cloudflareaccess.com";
const AUD = "test-audience";
const NOW = 1_800_000_000;

/** @type {CryptoKeyPair} */
let keys;
/** @type {JsonWebKey} */
let publicJwk;

/** @param {object} value */
const b64url = value =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * @param {object} [claims]
 * @param {string} [kid]
 * @param {string} [alg]
 */
async function sign(claims = {}, kid = "k1", alg = "RS256") {
  const header = b64url({ alg, kid });
  const payload = b64url({
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: NOW + 300,
    email: "owner@example.test",
    ...claims,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`)),
  );
  const sig = btoa(String.fromCharCode(...signature))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.${sig}`;
}

const certs = () => vi.fn(async () => Response.json({ keys: [{ ...publicJwk, kid: "k1", alg: "RS256", use: "sig" }] }));

beforeAll(async () => {
  keys = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )
  );
  publicJwk = /** @type {JsonWebKey} */ (await crypto.subtle.exportKey("jwk", keys.publicKey));
});

beforeEach(clearAccessKeyCache);

describe("verifyAccessJwt", () => {
  const verify = async (/** @type {string} */ token, fetchImpl = certs()) =>
    verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, fetchImpl, nowS: NOW });

  it("returns the email for a valid token", async () => {
    expect(await verify(await sign())).toEqual({ email: "owner@example.test" });
  });

  it("refuses the wrong audience", async () => {
    expect(await verify(await sign({ aud: ["someone-else"] }))).toBeNull();
  });

  it("refuses the wrong issuer", async () => {
    expect(await verify(await sign({ iss: "https://evil.cloudflareaccess.com" }))).toBeNull();
  });

  it("refuses a token expired by 61 seconds", async () => {
    expect(await verify(await sign({ exp: NOW - 61 }))).toBeNull();
  });

  it("refuses a token that isn't valid yet, beyond the clock skew", async () => {
    expect(await verify(await sign({ nbf: NOW + 61 }))).toBeNull();
    expect(await verify(await sign({ nbf: NOW + 59 }))).toEqual({ email: "owner@example.test" });
  });

  it("accepts an audience given as a string and refuses one that doesn't include it", async () => {
    expect(await verify(await sign({ aud: AUD }))).toEqual({ email: "owner@example.test" });
    expect(await verify(await sign({ aud: "someone-else" }))).toBeNull();
  });

  it("refuses an algorithm other than RS256, whatever the signature", async () => {
    expect(await verify(await sign({}, "k1", "HS256"))).toBeNull();
    expect(await verify(await sign({}, "k1", "none"))).toBeNull();
  });

  it("refuses a token with no email", async () => {
    expect(await verify(await sign({ email: undefined }))).toBeNull();
  });

  it("refuses a tampered payload", async () => {
    const [header, , signature] = (await sign()).split(".");
    const forged = b64url({ aud: [AUD], iss: `https://${TEAM}`, exp: NOW + 300, email: "attacker@example.test" });
    expect(await verify(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it("refetches the keys once for an unknown kid, then refuses", async () => {
    const fetchImpl = certs();
    await verify(await sign(), fetchImpl);
    expect(await verify(await sign({}, "k2"), fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("adminIdentity", () => {
  const request = (/** @type {string} */ token) =>
    new Request("https://admin.example.test/", { headers: { "Cf-Access-Jwt-Assertion": token } });

  it("refuses everything when the audience isn't configured, even a valid token", async () => {
    const env = { APP_ENV: "production", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "" };
    expect(await adminIdentity(request(await sign()), env, { fetchImpl: certs(), nowS: NOW })).toBeNull();
  });

  const owned = { APP_ENV: "production", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAIL: "Owner@Example.test" };

  it("accepts a valid token for the owner, matching the email case-insensitively", async () => {
    expect(await adminIdentity(request(await sign()), owned, { fetchImpl: certs(), nowS: NOW })).toEqual({
      email: "owner@example.test",
    });
  });

  it("refuses a valid token for anyone other than the owner", async () => {
    const token = await sign({ email: "someone@example.test" });
    expect(await adminIdentity(request(token), owned, { fetchImpl: certs(), nowS: NOW })).toBeNull();
  });

  it("refuses even the owner when the owner email isn't configured", async () => {
    const env = { ...owned, OWNER_EMAIL: "" };
    expect(await adminIdentity(request(await sign()), env, { fetchImpl: certs(), nowS: NOW })).toBeNull();
  });

  it("refuses a request with no token", async () => {
    const env = { APP_ENV: "production", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
    expect(await adminIdentity(new Request("https://admin.example.test/"), env)).toBeNull();
  });

  it("only skips the check in e2e and local development", async () => {
    const off = { ADMIN_ACCESS_CHECK: "off", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
    const bare = new Request("https://localhost/");
    expect(await adminIdentity(bare, { ...off, APP_ENV: "e2e" })).toEqual({ email: "dev@localhost" });
    expect(await adminIdentity(bare, { ...off, APP_ENV: "development" })).toEqual({ email: "dev@localhost" });
    expect(await adminIdentity(bare, { ...off, APP_ENV: "production" })).toBeNull();
    expect(await adminIdentity(bare, { ...off, APP_ENV: "preview" })).toBeNull();
  });
});

describe("serviceIdentity", () => {
  const CLIENT = "engage-client.access";
  const AUDIENCE = "results-audience";
  const service = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_RESULTS_AUD: AUDIENCE, RESULTS_CLIENT_ID: CLIENT };
  const options = () => ({ fetchImpl: certs(), nowS: NOW });
  const request = (/** @type {string} */ token) =>
    new Request("https://api.example.test/v1/results", { headers: { "Cf-Access-Jwt-Assertion": token } });
  const serviceToken = (/** @type {object} */ claims = {}) =>
    sign({ aud: [AUDIENCE], email: undefined, common_name: CLIENT, type: "app", ...claims });

  it("a service token for the results application is accepted", async () => {
    expect(await serviceIdentity(request(await serviceToken()), service, options())).toEqual({ clientId: CLIENT });
  });

  it("the owner's JWT is refused", async () => {
    const owner = await sign({ aud: [AUDIENCE] });
    expect(await serviceIdentity(request(owner), service, options())).toBeNull();
  });

  it("a token with another audience is refused", async () => {
    const other = await serviceToken({ aud: [AUD] });
    expect(await serviceIdentity(request(other), service, options())).toBeNull();
  });

  it("a service token for another client is refused", async () => {
    const other = await serviceToken({ common_name: "someone-else.access" });
    expect(await serviceIdentity(request(other), service, options())).toBeNull();
  });

  it("a missing RESULTS_CLIENT_ID refuses everything", async () => {
    const token = await serviceToken();
    for (const missing of [{ RESULTS_CLIENT_ID: "" }, { RESULTS_CLIENT_ID: undefined }]) {
      expect(await serviceIdentity(request(token), { ...service, ...missing }, options())).toBeNull();
    }
    expect(await serviceIdentity(request(token), { ...service, ACCESS_RESULTS_AUD: "" }, options())).toBeNull();
    expect(await serviceIdentity(request(token), { ...service, ACCESS_TEAM_DOMAIN: "" }, options())).toBeNull();
  });

  it("a request with no token, or an expired one, is refused", async () => {
    expect(await serviceIdentity(new Request("https://api.example.test/v1/results"), service, options())).toBeNull();
    const expired = await serviceToken({ exp: NOW - 61 });
    expect(await serviceIdentity(request(expired), service, options())).toBeNull();
  });

  it("never skips the check, even in e2e", async () => {
    const env = { ...service, APP_ENV: "e2e", ADMIN_ACCESS_CHECK: "off" };
    expect(await serviceIdentity(new Request("https://localhost/v1/results"), env)).toBeNull();
  });
});
