import { env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { changeSetting, describeActor, retryUnnotified } from "../src/settings/store.js";

const OWNER = "owner@example.test";
const base = { DB: env.DB, OWNER_EMAIL: OWNER, DISCORD_WEBHOOK_URL: "https://discord.example.test/api/webhooks/1/t" };

/** @param {number} status */
function discord(status) {
  /** @type {string[]} */
  const posted = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (_url, init) => {
    posted.push(JSON.parse(String(init?.body)).content);
    return new Response(null, { status });
  };
  return { posted, fetchImpl };
}

/** @param {string} value */
const putOwners = value => db => [
  db
    .prepare("INSERT INTO settings (key, value) VALUES ('owners', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
    .bind(value),
];

const audit = async () => (await env.DB.prepare("SELECT * FROM settings_audit ORDER BY id").all()).results;
const settings = async () => (await env.DB.prepare("SELECT * FROM settings").all()).results;

beforeEach(async () => {
  await env.DB.batch(
    ["settings", "settings_audit", "exceptions", "known_tokens"].map(t => env.DB.prepare(`DELETE FROM ${t}`)),
  );
});

test("changeSetting writes the change and its audit row together", async () => {
  const { fetchImpl } = discord(204);
  await changeSetting(
    base,
    { actor: "the owner", key: "owners", from: [], to: ["raven"], apply: putOwners('["raven"]') },
    fetchImpl,
  );
  expect(await settings()).toEqual([{ key: "owners", value: '["raven"]' }]);
  const rows = await audit();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    actor: "the owner",
    key: "owners",
    from_value: "[]",
    to_value: '["raven"]',
    notified: 1,
  });
  expect(rows[0].changed_at).toEqual(expect.any(String));
});

test("when apply throws, neither the change nor an audit row is written", async () => {
  const { fetchImpl, posted } = discord(204);
  await expect(
    changeSetting(
      base,
      {
        actor: "the owner",
        key: "owners",
        from: [],
        to: ["raven"],
        apply: () => {
          throw new Error("bad");
        },
      },
      fetchImpl,
    ),
  ).rejects.toThrow("bad");
  expect(await settings()).toEqual([]);
  expect(await audit()).toEqual([]);
  expect(posted).toEqual([]);
});

test("when a statement fails, the batch rolls back the audit row too", async () => {
  const { fetchImpl, posted } = discord(204);
  await expect(
    changeSetting(
      base,
      {
        actor: "the owner",
        key: "exceptions",
        from: null,
        to: { reason: "" },
        apply: db => [
          db.prepare("INSERT INTO exceptions (target, check_id, reason) VALUES ('engage', 'secrets-known', '')"),
        ],
      },
      fetchImpl,
    ),
  ).rejects.toThrow();
  expect(await audit()).toEqual([]);
  expect(posted).toEqual([]);
});

test("changeSetting posts one line with no email address", async () => {
  const { fetchImpl, posted } = discord(204);
  await changeSetting(
    { ...base, ADMIN_HOST: "guardian.example.test" },
    {
      actor: describeActor(base, OWNER),
      key: "exceptions",
      from: null,
      to: { reason: `Approved by ${OWNER}` },
      apply: db => [
        db.prepare("INSERT INTO exceptions (target, check_id, reason) VALUES ('engage', 'secrets-known', 'Approved')"),
      ],
    },
    fetchImpl,
  );
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/^Guardian settings: the owner changed exceptions/);
  expect(posted[0]).toContain("https://guardian.example.test/");
  expect(posted[0]).not.toMatch(/@/);
});

test("a Discord failure keeps the change unnotified, and retryUnnotified posts it later", async () => {
  const down = discord(500);
  const result = await changeSetting(
    base,
    { actor: "the owner", key: "owners", from: [], to: ["raven"], apply: putOwners('["raven"]') },
    down.fetchImpl,
  );
  expect(result).toEqual({ notified: false });
  expect(await settings()).toHaveLength(1);
  expect((await audit())[0].notified).toBe(0);

  const up = discord(204);
  expect(await retryUnnotified(base, up.fetchImpl)).toBe(1);
  expect(up.posted).toEqual(["Guardian settings: the owner changed owners"]);
  expect((await audit())[0].notified).toBe(1);
  expect(await retryUnnotified(base, up.fetchImpl)).toBe(0);
});

test("retryUnnotified leaves rows unnotified while Discord stays down", async () => {
  const down = discord(500);
  await changeSetting(
    base,
    { actor: "the owner", key: "owners", from: [], to: ["raven"], apply: putOwners('["raven"]') },
    down.fetchImpl,
  );
  expect(await retryUnnotified(base, down.fetchImpl)).toBe(0);
  expect((await audit())[0].notified).toBe(0);
});

test("an exception with a blank reason is refused by the schema", async () => {
  for (const reason of ["", "   "]) {
    await expect(
      env.DB.prepare("INSERT INTO exceptions (target, check_id, reason) VALUES ('engage', 'visibility', ?1)")
        .bind(reason)
        .run(),
    ).rejects.toThrow();
  }
  expect((await env.DB.prepare("SELECT count(*) AS n FROM exceptions").first())?.n).toBe(0);
});

test("a known token with a blank purpose is refused by the schema", async () => {
  for (const purpose of ["", "   "]) {
    await expect(
      env.DB.prepare("INSERT INTO known_tokens (token_id, name, purpose) VALUES ('t1', 'Engage Deploy', ?1)")
        .bind(purpose)
        .run(),
    ).rejects.toThrow();
  }
  expect((await env.DB.prepare("SELECT count(*) AS n FROM known_tokens").first())?.n).toBe(0);
});

test("describeActor names only the owner, and never echoes an email", () => {
  expect(describeActor(base, OWNER)).toBe("the owner");
  expect(describeActor(base, " Owner@Example.test ")).toBe("the owner");
  expect(describeActor(base, "someone@example.test")).toBe("another Access user");
  expect(describeActor({ ...base, OWNER_EMAIL: "" }, "")).toBe("another Access user");
  expect(describeActor({ ...base, OWNER_EMAIL: undefined }, OWNER)).toBe("another Access user");
});
