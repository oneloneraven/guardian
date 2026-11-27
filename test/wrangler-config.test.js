import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""),
);
const environments = { top: config, ...config.env };

test("every environment runs the Worker before static assets, so the admin check sees every request", () => {
  for (const [name, env] of Object.entries(environments)) {
    expect(env.assets?.run_worker_first, name).toBe(true);
  }
});

test("in e2e, the identity the skipped Access check gives is the owner", () => {
  expect(config.env.e2e.vars.ADMIN_ACCESS_CHECK).toBe("off");
  expect(config.env.e2e.vars.OWNER_EMAIL).toBe("dev@localhost");
});

test("only production has cron triggers: the five-minute tick and the daily run", () => {
  expect(config.env.production.triggers).toEqual({ crons: ["*/5 * * * *", "41 3 * * *"] });
  for (const [name, env] of Object.entries(environments)) {
    if (name !== "production") expect(env.triggers, name).toBeUndefined();
  }
});
