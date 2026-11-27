import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The Workers pool can't read the filesystem, so migrations go in as a binding.
const migrations = await readD1Migrations("./migrations");

const NODE_TESTS = [
  "test/ui-*.test.js",
  "test/lib/**/*.test.js",
  "test/worker.test.js",
  "test/wrangler-config.test.js",
];

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: { provider: "v8", reporter: ["text", "json-summary"] },
    projects: [
      {
        test: {
          name: "workers",
          include: ["test/**/*.test.js"],
          exclude: NODE_TESTS,
          setupFiles: ["./test/apply-migrations.js"],
        },
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // Tests never reach a real service: one that wants a reply stubs fetch, and anything else lands here.
              outboundService: request =>
                new Response(`Tests can't reach ${new URL(request.url).hostname}`, { status: 599 }),
              bindings: { TEST_D1_MIGRATIONS: migrations },
            },
          }),
        ],
      },
      {
        test: { name: "node", include: NODE_TESTS, environment: "node" },
      },
    ],
  },
});
