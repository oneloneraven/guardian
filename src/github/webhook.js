import { deliverPending } from "../alerts/outbox.js";
import { raiseFor } from "../alerts/raise-for.js";
import { checkOrganisation, checkRepository } from "../checks/run.js";
import { hmacHex, timingSafeEqual } from "../lib/hmac.js";
import { recordEvent } from "../results/store.js";
import { installationToken } from "./app.js";
import { summarise } from "./events.js";
import { reader as githubReader } from "./reader.js";

/**
 * @typedef {import("../checks/run.js").RunEnv & { GITHUB_WEBHOOK_SECRET?: string }} WebhookEnv
 * @typedef {{ waitUntil: (promise: Promise<unknown>) => void }} Context
 */

const MAX_BYTES = 5 * 1024 * 1024;

/** @param {number} status */
const respond = status => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * @param {WebhookEnv} env
 * @param {import("./events.js").Summary} summary
 * @param {string} event
 * @param {any} payload
 * @param {() => Promise<import("./reader.js").Reader>} [readerFor]
 */
async function recheck(env, summary, event, payload, readerFor) {
  try {
    const read = readerFor ? await readerFor() : githubReader(await installationToken(env));
    const transitions =
      summary.scope === "repository"
        ? await checkRepository(env, read, summary.target, "event")
        : await checkOrganisation(env, read, "event");
    if (event === "installation_repositories") {
      for (const added of payload.repositories_added ?? []) {
        if (typeof added?.name === "string")
          transitions.push(...(await checkRepository(env, read, added.name, "event")));
      }
    }
    await raiseFor(env, transitions);
    await deliverPending(env);
  } catch (error) {
    console.error("GitHub webhook re-check failed", error instanceof Error ? error.message : error);
  }
}

/**
 * @param {Request} request
 * @param {WebhookEnv} env
 * @param {Context} ctx
 * @param {{ readerFor?: () => Promise<import("./reader.js").Reader> }} [options]
 * @returns {Promise<Response>}
 */
export async function handleGithubWebhook(request, env, ctx, { readerFor } = {}) {
  if (request.method !== "POST")
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BYTES) return respond(413);
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_BYTES) return respond(413);

  if (!env.GITHUB_WEBHOOK_SECRET) {
    console.error("GitHub webhook secret isn't set");
    return respond(401);
  }
  const expected = `sha256=${await hmacHex(env.GITHUB_WEBHOOK_SECRET, body)}`;
  if (!timingSafeEqual(expected, request.headers.get("X-Hub-Signature-256") ?? "")) return respond(401);

  /** @type {any} */
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return respond(400);
  }
  const event = request.headers.get("X-GitHub-Event") ?? "";
  const summary = summarise(event, payload);
  if (!summary) return respond(204);
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!delivery) return respond(400);

  const stored = await recordEvent(env, {
    delivery,
    source: "github",
    target: summary.target,
    action: summary.action,
    actor: summary.actor,
    detail: summary.detail,
    at: new Date().toISOString(),
  });
  if (stored) ctx.waitUntil(recheck(env, summary, event, payload, readerFor));
  return respond(202);
}
