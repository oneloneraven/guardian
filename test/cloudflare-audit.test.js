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
  await recordAudit(config, entries, NOW, true);
  expect(await watermark()).toBe(iso(NOW));
});

test("re-reads the overlap and stores a late entry once", async () => {
  await recordAudit(
    config,
    entriesOf(await readAudit(config, NOW - 5 * MINUTE, serve([{ result: [raw("a")] }]).fetchImpl)),
    NOW - 5 * MINUTE,
    true,
  );
  const late = raw("late", {
    action: { type: "update", result: "success", description: "Late", time: iso(NOW - 8 * MINUTE) },
  });
  const { fetchImpl, calls } = serve([{ result: [raw("a"), late] }]);
  const read = entriesOf(await readAudit(config, NOW, fetchImpl));
  expect(calls[0].searchParams.get("since")).toBe(iso(NOW - 15 * MINUTE));
  expect(calls[0].searchParams.get("before")).toBe(iso(NOW));
  const fresh = await recordAudit(config, read, NOW, true);
  expect(fresh.map(entry => entry.id)).toEqual(["late"]);
  await recordAudit(config, read, NOW, true);
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
  expect(await recordAudit(config, [{ ...entries[0], id: "v", actionType: "view" }], NOW, true)).toEqual([]);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM security_events").first())?.n).toBe(0);
});

test("no stored field holds an @", async () => {
  const entry = raw("e", {
    action: { type: "create", result: "success", description: "Invited a@b.example", time: iso(NOW) },
    actor: { type: "user", context: "dashboard", email: "someone@example.com", token_name: "deploy@guardian" },
  });
  const entries = entriesOf(await readAudit(config, NOW, serve([{ result: [entry, raw("f")] }]).fetchImpl));
  await recordAudit(config, entries, NOW, true);
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

test("a backlog over 20 pages is read in chunks and the watermark moves to the last entry read", async () => {
  const pages = Array.from({ length: 25 }, (_, index) => ({
    result: [
      raw(`e${index}`, {
        action: { type: "create", result: "success", description: "Create", time: iso(NOW - (60 - index) * MINUTE) },
      }),
    ],
    cursor: `c${index}`,
  }));
  const { fetchImpl, calls } = serve(pages);
  const read = await readAudit(config, NOW, fetchImpl);
  expect(calls).toHaveLength(20);
  expect(read).toMatchObject({ complete: false });
  const entries = entriesOf(read);
  expect(entries).toHaveLength(20);
  await recordAudit(config, entries, NOW, /** @type {any} */ (read).complete);
  expect(await watermark()).toBe(iso(NOW - 41 * MINUTE));
  const next = serve([{}]);
  await readAudit(config, NOW, next.fetchImpl);
  expect(next.calls[0].searchParams.get("since")).toBe(iso(NOW - 51 * MINUTE));
});

test("a complete read moves the watermark to now", async () => {
  const read = await readAudit(config, NOW, serve([{ result: [raw("a")] }]).fetchImpl);
  expect(read).toMatchObject({ complete: true });
  await recordAudit(config, entriesOf(read), NOW, /** @type {any} */ (read).complete);
  expect(await watermark()).toBe(iso(NOW));
});

test("an account token's id is stored with its event", async () => {
  const entry = raw("t", {
    actor: { type: "account", context: "api", token_id: "tok-123", email: "someone@example.com" },
    action: { type: "create", result: "success", description: "Query D1 Database", time: iso(NOW) },
    resource: { id: "db", type: "database.query", product: "d1", scope: "accounts" },
  });
  const entries = entriesOf(await readAudit(config, NOW, serve([{ result: [entry, raw("u")] }]).fetchImpl));
  await recordAudit(config, entries, NOW, true);
  const { results } = await env.DB.prepare(
    "SELECT delivery, actor, actor_token_id FROM security_events ORDER BY delivery",
  ).all();
  expect(results).toEqual([
    { delivery: "cf:t", actor: "an account token", actor_token_id: "tok-123" },
    { delivery: "cf:u", actor: "a dashboard user", actor_token_id: null },
  ]);
});

test("the token id is read from where the live log puts it, and a user's API token is named as one", async () => {
  const user = raw("p", {
    actor: { type: "user", context: "api_token", id: "user-1", token: { id: "29f469eb90bcc0227ec10caced410345" } },
    action: { type: "create", result: "success", description: "Create a namespace", time: iso(NOW) },
    resource: { id: "ns", type: "kv.namespaces", product: "storage", scope: "accounts" },
  });
  const account = raw("q", {
    actor: { type: "account", context: "api_token", id: "account-1", token: { id: "tok-acc", name: "Deploy" } },
    action: { type: "create", result: "success", description: "Upload Version", time: iso(NOW) },
    resource: { id: "guardian-production", type: "scripts.versions", product: "workers", scope: "accounts" },
  });
  const entries = entriesOf(await readAudit(config, NOW, serve([{ result: [user, account] }]).fetchImpl));
  await recordAudit(config, entries, NOW, true);
  const { results } = await env.DB.prepare(
    "SELECT delivery, actor, actor_token_id FROM security_events ORDER BY delivery",
  ).all();
  expect(results).toEqual([
    { delivery: "cf:p", actor: "a user API token", actor_token_id: "29f469eb90bcc0227ec10caced410345" },
    { delivery: "cf:q", actor: "Deploy", actor_token_id: "tok-acc" },
  ]);
});
