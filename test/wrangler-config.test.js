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
