import { routeAdmin } from "./admin/router.js";
import { routeResults } from "./api/results.js";
import { runScheduled } from "./cron.js";
import { handleGithubWebhook } from "./github/webhook.js";
import { adminIdentity, serviceIdentity } from "./lib/access.js";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: (request: Request) => Promise<Response> }, APP_ENV: string, RELEASE_VERSION?: string, ADMIN_HOST?: string, ADMIN_ACCESS_CHECK?: string, ACCESS_TEAM_DOMAIN?: string, ACCESS_AUD?: string, ACCESS_RESULTS_AUD?: string, RESULTS_CLIENT_ID?: string, OWNER_EMAIL?: string, DISCORD_WEBHOOK_URL?: string, GITHUB_WEBHOOK_SECRET?: string, GITHUB_ORG?: string, GITHUB_APP_ID?: string, GITHUB_APP_PRIVATE_KEY?: string, DB: import("./lib/db.js").Database }} env
   * @param {{ waitUntil: (promise: Promise<unknown>) => void }} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const { hostname, pathname } = new URL(request.url);
    if (pathname === "/api/health") {
      return Response.json(
        { ok: true, environment: env.APP_ENV, version: env.RELEASE_VERSION ?? "unreleased" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (env.ADMIN_HOST && hostname === env.ADMIN_HOST) {
      const identity = await adminIdentity(request, env);
      if (!identity) return notFound();
      if (pathname.startsWith("/api/"))
        return routeAdmin(request, env, identity, undefined, { waitUntil: promise => ctx.waitUntil(promise) });
      return env.ASSETS.fetch(request);
    }
    if (pathname === "/v1/github/webhook") return handleGithubWebhook(request, env, ctx);
    if (pathname.startsWith("/v1/")) {
      if (!(await serviceIdentity(request, env))) {
        return Response.json({ error: "Forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
      }
      return routeResults(request, env);
    }
    return notFound();
  },

  /**
   * @param {{ cron: string, scheduledTime: number }} controller
   * @param {Parameters<typeof runScheduled>[0]} env
   * @param {{ waitUntil: (promise: Promise<unknown>) => void }} ctx
   */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, controller, ctx));
  },
};
