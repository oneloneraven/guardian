import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { readAudit, recordAudit } from "../src/cloudflare/audit.js";

const NOW = Date.UTC(2026, 10, 28, 12, 0);
const MINUTE = 60_000;
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

const config = { ...env, CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_AUDIT_TOKEN: "secret-token" };

beforeEach(async () => {
  await env.DB.batch(["security_events", "cursors"].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});

/** @param {string} id @param {Record<string, any>} [over] */
const raw = (id, over = {}) => ({
  id,
  action: { type: "create", result: "success", description: "Create token", time: iso(NOW - 5 * MINUTE) },
  actor: { type: "user", context: "dashboard", email: "someone@example.com" },
  resource: { id: "res", type: "token", product: "api_tokens", scope: "accounts" },
  zone: {},
  raw: {},
  ...over,
});

/** @param {{ status?: number, result?: any[], cursor?: string }[]} pages */
function serve(pages) {
  /** @type {URL[]} */
  const calls = [];
  /** @type {RequestInit[]} */
  const inits = [];
  const fetchImpl = /** @type {typeof fetch} */ (
    async (/** @type {any} */ url, /** @type {any} */ init) => {
      calls.push(new URL(String(url)));
      inits.push(init);
      const page = pages[Math.min(calls.length - 1, pages.length - 1)];
      return new Response(
        JSON.stringify({ success: true, result: page.result ?? [], result_info: { cursor: page.cursor ?? "" } }),
        { status: page.status ?? 200 },
      );
    }
  );
  return { fetchImpl, calls, inits };
}

const watermark = async () =>
  (await env.DB.prepare("SELECT position FROM cursors WHERE name = 'cloudflare-audit'").first())?.position ?? null;

/** @param {any} read */
const entriesOf = read => {
  expect(read).toHaveProperty("entries");
  return read.entries;
};

test("reads every page by cursor before moving the watermark", async () => {
  const { fetchImpl, calls, inits } = serve([
    { result: [raw("a"), raw("b")], cursor: "c1" },
    { result: [raw("c")], cursor: "c2" },
    { result: [raw("d")] },
  ]);
  const entries = entriesOf(await readAudit(config, NOW, fetchImpl));
  expect(entries.map((/** @type {any} */ entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
  expect(calls).toHaveLength(3);
  expect(calls[0].pathname).toBe("/client/v4/accounts/acct/logs/audit");
  expect(calls[0].searchParams.get("direction")).toBe("asc");
  expect(calls[0].searchParams.get("limit")).toBe("1000");
  expect(calls[0].searchParams.get("action_type[not]")).toBe("view");
  expect(calls[0].searchParams.get("cursor")).toBeNull();
  expect(calls[1].searchParams.get("cursor")).toBe("c1");
  expect(calls[2].searchParams.get("cursor")).toBe("c2");
  expect(/** @type {any} */ (inits[0].headers).Authorization).toBe("Bearer secret-token");
  expect(await watermark()).toBeNull();
  await recordAudit(config, entries, NOW);
  expect(await watermark()).toBe(iso(NOW));
});

test("re-reads the overlap and stores a late entry once", async () => {
  await recordAudit(
    config,
    entriesOf(await readAudit(config, NOW - 5 * MINUTE, serve([{ result: [raw("a")] }]).fetchImpl)),
    NOW - 5 * MINUTE,
  );
  const late = raw("late", {
    action: { type: "update", result: "success", description: "Late", time: iso(NOW - 8 * MINUTE) },
  });
  const { fetchImpl, calls } = serve([{ result: [raw("a"), late] }]);
  const read = entriesOf(await readAudit(config, NOW, fetchImpl));
  expect(calls[0].searchParams.get("since")).toBe(iso(NOW - 15 * MINUTE));
  expect(calls[0].searchParams.get("before")).toBe(iso(NOW));
  const fresh = await recordAudit(config, read, NOW);
  expect(fresh.map(entry => entry.id)).toEqual(["late"]);
  await recordAudit(config, read, NOW);
  const { results } = await env.DB.prepare("SELECT delivery FROM security_events ORDER BY delivery").all();
  expect(results.map(row => row.delivery)).toEqual(["cf:a", "cf:late"]);
});

test("a 403 names Audit Logs Read and leaves the watermark", async () => {
  await env.DB.prepare("INSERT INTO cursors (name, position, updated_at) VALUES ('cloudflare-audit', ?1, ?1)")
    .bind(iso(NOW - 5 * MINUTE))
    .run();
  const read = await readAudit(config, NOW, serve([{ status: 403 }]).fetchImpl);
  expect(read).toEqual({ unreadable: "Can't read the audit log: the token needs Audit Logs Read" });
  expect(await watermark()).toBe(iso(NOW - 5 * MINUTE));
  expect(await readAudit(config, NOW, serve([{ status: 500 }]).fetchImpl)).toEqual({
    unreadable: "Couldn't read the audit log (HTTP 500)",
  });
});

test("view entries are skipped", async () => {
  const view = raw("v", { action: { type: "view", result: "success", description: "View", time: iso(NOW) } });
  const entries = entriesOf(await readAudit(config, NOW, serve([{ result: [view, raw("a")] }]).fetchImpl));
  expect(entries.map((/** @type {any} */ entry) => entry.id)).toEqual(["a"]);
  expect(await recordAudit(config, [{ ...entries[0], id: "v", actionType: "view" }], NOW)).toEqual([]);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM security_events").first())?.n).toBe(0);
});

test("no stored field holds an @", async () => {
  const entry = raw("e", {
    action: { type: "create", result: "success", description: "Invited a@b.example", time: iso(NOW) },
    actor: { type: "user", context: "dashboard", email: "someone@example.com", token_name: "deploy@guardian" },
  });
  const entries = entriesOf(await readAudit(config, NOW, serve([{ result: [entry, raw("f")] }]).fetchImpl));
  await recordAudit(config, entries, NOW);
  const { results } = await env.DB.prepare("SELECT * FROM security_events").all();
  expect(results).toHaveLength(2);
  expect(JSON.stringify(results)).not.toContain("@");
  expect(JSON.stringify(entries)).not.toContain("@");
  expect(results.map(row => row.actor).sort()).toEqual(["a dashboard user", "deploy guardian"]);
  expect(results.find(row => row.delivery === "cf:f")?.detail).toBe(
    "`a dashboard user`: Create token (api_tokens token)",
  );
});

test("missing token is unreadable without a fetch", async () => {
  const { fetchImpl, calls } = serve([{}]);
  const expected = { unreadable: "Guardian has no Cloudflare audit token" };
  expect(await readAudit({ ...env, CLOUDFLARE_ACCOUNT_ID: "acct" }, NOW, fetchImpl)).toEqual(expected);
  expect(await readAudit({ ...env, CLOUDFLARE_AUDIT_TOKEN: "t" }, NOW, fetchImpl)).toEqual(expected);
  expect(calls).toHaveLength(0);
});

test("the first run reads the last 15 minutes", async () => {
  const { fetchImpl, calls } = serve([{}]);
  await readAudit(config, NOW, fetchImpl);
  expect(calls[0].searchParams.get("since")).toBe(iso(NOW - 15 * MINUTE));
  expect(calls[0].searchParams.get("before")).toBe(iso(NOW));
});
