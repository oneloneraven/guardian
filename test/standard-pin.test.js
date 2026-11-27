import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { loadStandard, pinStandard } from "../src/standard/pin.js";
import real from "./fixtures/standard-v1.18.0.json?raw";

const REAL_SHA = "469aeb66711b9d2532db06ac84123082745ff2fd949a74765fdf025b034a2402";
const OWNER = "owner@example.test";
const base = { DB: env.DB, OWNER_EMAIL: OWNER };
const assetUrl = (/** @type {string} */ version) =>
  `https://github.com/oneloneraven/project-bootstrap/releases/download/${version}/standard.json`;

/** @param {string} text */
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {Record<string, string | number>} bodies
 * @returns {{ fetchImpl: typeof fetch, requested: string[] }}
 */
function github(bodies) {
  /** @type {string[]} */
  const requested = [];
  return {
    requested,
    fetchImpl: async url => {
      requested.push(String(url));
      const body = bodies[String(url)];
      if (body === undefined) return new Response("Not Found", { status: 404 });
      if (typeof body === "number") return new Response("", { status: body });
      return new Response(body, { status: 200 });
    },
  };
}

const counts = async () => ({
  standard: (await env.DB.prepare("SELECT count(*) AS n FROM standard").first())?.n,
  settings: (await env.DB.prepare("SELECT count(*) AS n FROM settings").first())?.n,
  audit: (await env.DB.prepare("SELECT count(*) AS n FROM settings_audit").first())?.n,
});

beforeEach(async () => {
  await env.DB.batch(["settings", "settings_audit", "standard"].map(t => env.DB.prepare(`DELETE FROM ${t}`)));
});

test("the fixture is the real v1.18.0 asset", async () => {
  expect(await sha256(real)).toBe(REAL_SHA);
});

test("pins the real v1.18.0 asset when the checksum matches, and audits it", async () => {
  const { fetchImpl, requested } = github({ [assetUrl("v1.18.0")]: real });
  expect(await pinStandard(base, { version: "v1.18.0", sha256: REAL_SHA, email: OWNER }, fetchImpl)).toEqual({
    ok: true,
  });
  expect(requested).toEqual([assetUrl("v1.18.0")]);
  const loaded = await loadStandard(base);
  expect(loaded).toMatchObject({ version: "v1.18.0", standard: { bootstrap: "v1.18.0", version: 2 } });
  const audit = await env.DB.prepare("SELECT actor, key, from_value, to_value FROM settings_audit").all();
  expect(audit.results).toEqual([
    {
      actor: "the owner",
      key: "standard",
      from_value: null,
      to_value: JSON.stringify({ version: "v1.18.0", sha256: REAL_SHA }),
    },
  ]);
});

test("accepts the checksum in upper case", async () => {
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: real });
  const result = await pinStandard(
    base,
    { version: "v1.18.0", sha256: REAL_SHA.toUpperCase(), email: OWNER },
    fetchImpl,
  );
  expect(result).toEqual({ ok: true });
});

test("refuses a checksum mismatch, naming it, and stores nothing", async () => {
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: real });
  const wrong = "0".repeat(64);
  const result = await pinStandard(base, { version: "v1.18.0", sha256: wrong, email: OWNER }, fetchImpl);
  expect(result).toEqual({ ok: false, reason: `Checksum mismatch: expected ${wrong}, got ${REAL_SHA}` });
  expect(await counts()).toEqual({ standard: 0, settings: 0, audit: 0 });
});

test("refuses a matching checksum whose bootstrap field names another version, and keeps the previous pin", async () => {
  const restamped = real.replace('"bootstrap": "v1.18.0"', '"bootstrap": "v1.18.0" ').trimEnd();
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: real, [assetUrl("v1.19.0")]: restamped });
  await pinStandard(base, { version: "v1.18.0", sha256: REAL_SHA, email: OWNER }, fetchImpl);

  const result = await pinStandard(
    base,
    { version: "v1.19.0", sha256: await sha256(restamped), email: OWNER },
    fetchImpl,
  );
  expect(result).toEqual({ ok: false, reason: "The asset says it is v1.18.0, not v1.19.0" });
  expect(await loadStandard(base)).toMatchObject({ version: "v1.18.0" });
  expect(await counts()).toEqual({ standard: 1, settings: 1, audit: 1 });
});

test("refuses schema version 3", async () => {
  const v3 = JSON.stringify({ ...JSON.parse(real), version: 3 });
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: v3 });
  const result = await pinStandard(base, { version: "v1.18.0", sha256: await sha256(v3), email: OWNER }, fetchImpl);
  expect(result).toEqual({ ok: false, reason: "Unsupported standard schema version 3" });
  expect(await counts()).toEqual({ standard: 0, settings: 0, audit: 0 });
});

test("refuses an asset that isn't JSON", async () => {
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: "<html>" });
  const result = await pinStandard(
    base,
    { version: "v1.18.0", sha256: await sha256("<html>"), email: OWNER },
    fetchImpl,
  );
  expect(result).toEqual({ ok: false, reason: "The asset isn't valid JSON" });
});

test("refuses a non-200 without storing anything", async () => {
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: 502 });
  const result = await pinStandard(base, { version: "v1.18.0", sha256: REAL_SHA, email: OWNER }, fetchImpl);
  expect(result).toEqual({ ok: false, reason: "Download failed: HTTP 502" });
  expect(await counts()).toEqual({ standard: 0, settings: 0, audit: 0 });
});

test("refuses a download that times out, without crashing or storing anything", async () => {
  /** @type {typeof fetch} */
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  const result = await pinStandard(base, { version: "v1.18.0", sha256: REAL_SHA, email: OWNER }, hang, 10);
  expect(result).toEqual({ ok: false, reason: "Download failed: timed out" });
  expect(await counts()).toEqual({ standard: 0, settings: 0, audit: 0 });
});

test("refuses a malformed version or checksum before downloading anything", async () => {
  const { fetchImpl, requested } = github({});
  for (const version of ["1.18.0", "v1.18", "v1.18.0/../../x", ""]) {
    const result = await pinStandard(base, { version, sha256: REAL_SHA, email: OWNER }, fetchImpl);
    expect(result).toEqual({ ok: false, reason: "version must look like v1.2.3" });
  }
  for (const sha of ["abc", "g".repeat(64), ""]) {
    const result = await pinStandard(base, { version: "v1.18.0", sha256: sha, email: OWNER }, fetchImpl);
    expect(result).toEqual({ ok: false, reason: "sha256 must be 64 hexadecimal characters" });
  }
  expect(requested).toEqual([]);
});

test("loadStandard is unknown with no pin", async () => {
  expect(await loadStandard(base)).toEqual({ unknown: "No standard pinned" });
});

test("loadStandard is unknown when the pinned copy is missing", async () => {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('standard', '{"version":"v1.18.0","sha256":"${REAL_SHA}"}')`,
  ).run();
  expect(await loadStandard(base)).toEqual({ unknown: "Pinned standard missing" });
});

test("loadStandard is unknown when the stored copy no longer matches its checksum", async () => {
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: real });
  await pinStandard(base, { version: "v1.18.0", sha256: REAL_SHA, email: OWNER }, fetchImpl);
  await env.DB.prepare("UPDATE standard SET body = '{}'").run();
  expect(await loadStandard(base)).toEqual({ unknown: "Pinned standard fails its checksum" });
});

test("loadStandard is unknown when the pin itself is unreadable, and a new pin still works", async () => {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('standard', 'not json')").run();
  expect(await loadStandard(base)).toEqual({ unknown: "Pinned standard unreadable" });
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: real });
  expect(await pinStandard(base, { version: "v1.18.0", sha256: REAL_SHA, email: OWNER }, fetchImpl)).toEqual({
    ok: true,
  });
  expect(await loadStandard(base)).toMatchObject({ version: "v1.18.0" });
});

test("a failure to save is a refusal, not a crash", async () => {
  const db = {
    prepare: (/** @type {string} */ sql) => env.DB.prepare(sql),
    batch: () => Promise.reject(new Error("D1 unavailable")),
  };
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: real });
  const result = await pinStandard(
    { ...base, DB: /** @type {any} */ (db) },
    { version: "v1.18.0", sha256: REAL_SHA, email: OWNER },
    fetchImpl,
  );
  expect(result).toEqual({ ok: false, reason: "Couldn't save the standard" });
});

test("refuses an asset over 1 MB", async () => {
  const big = "x".repeat(1_000_001);
  const { fetchImpl } = github({ [assetUrl("v1.18.0")]: big });
  const result = await pinStandard(base, { version: "v1.18.0", sha256: await sha256(big), email: OWNER }, fetchImpl);
  expect(result).toEqual({ ok: false, reason: "The asset is too large" });
  expect(await counts()).toEqual({ standard: 0, settings: 0, audit: 0 });
});

test("refuses a version or checksum that isn't a string", async () => {
  const { fetchImpl, requested } = github({});
  const asAny = (/** @type {unknown} */ value) => /** @type {any} */ (value);
  expect(await pinStandard(base, { version: asAny(1), sha256: REAL_SHA, email: OWNER }, fetchImpl)).toEqual({
    ok: false,
    reason: "version must look like v1.2.3",
  });
  expect(await pinStandard(base, { version: "v1.18.0", sha256: asAny(null), email: OWNER }, fetchImpl)).toEqual({
    ok: false,
    reason: "sha256 must be 64 hexadecimal characters",
  });
  expect(requested).toEqual([]);
});
