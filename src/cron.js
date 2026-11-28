import { deliverPending, pruneAlerts } from "./alerts/outbox.js";
import { raiseFor } from "./alerts/raise-for.js";
import { sweep } from "./checks/run.js";
import { watchAudit } from "./cloudflare/watch.js";
import { pingHeartbeat } from "./heartbeat.js";
import { pruneEvents } from "./results/store.js";
import { retryUnnotified } from "./settings/store.js";

/**
 * @typedef {Parameters<typeof sweep>[0] & Parameters<typeof retryUnnotified>[0] & Parameters<typeof watchAudit>[0] & Parameters<typeof pingHeartbeat>[0]} CronEnv
 * @typedef {{
 *   retryUnnotified: typeof retryUnnotified,
 *   watchAudit: typeof watchAudit,
 *   sweep: typeof sweep,
 *   raiseFor: typeof raiseFor,
 *   pruneEvents: typeof pruneEvents,
 *   pruneAlerts: typeof pruneAlerts,
 *   deliverPending: typeof deliverPending,
 *   pingHeartbeat: typeof pingHeartbeat,
 * }} Deps
 */

const EVERY_FIVE_MINUTES = "*/5 * * * *";
const DAILY = "41 3 * * *";
const SWEEP_MINUTES = new Set([0, 15, 30, 45]);

/** @type {Deps} */
const REAL = { retryUnnotified, watchAudit, sweep, raiseFor, pruneEvents, pruneAlerts, deliverPending, pingHeartbeat };

/**
 * @template T
 * @param {string} step
 * @param {() => Promise<T>} run
 * @returns {Promise<T | undefined>}
 */
async function attempt(step, run) {
  try {
    return await run();
  } catch (error) {
    console.error(`${step} failed`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

/**
 * @param {CronEnv} env
 * @param {{ cron: string, scheduledTime: number }} controller
 * @param {{ waitUntil: (promise: Promise<unknown>) => void }} _ctx
 * @param {Partial<Deps>} [overrides]
 * @returns {Promise<void>}
 */
export async function runScheduled(env, { cron, scheduledTime }, _ctx, overrides = {}) {
  const deps = { ...REAL, ...overrides };
  const now = new Date(scheduledTime);
  const daily = cron === DAILY;
  const sweeping = daily || (cron === EVERY_FIVE_MINUTES && SWEEP_MINUTES.has(now.getUTCMinutes()));

  await attempt("Retrying settings announcements", () => deps.retryUnnotified(env));
  await attempt("Reading the Cloudflare audit log", () => deps.watchAudit(env, now));
  if (sweeping) {
    const outcome = await attempt("Sweep", () => deps.sweep(env, daily ? "daily" : "sweep"));
    if (outcome) await attempt("Raising alerts", () => deps.raiseFor(env, outcome.transitions));
  }
  if (daily) {
    await attempt("Pruning events", () => deps.pruneEvents(env, now));
    await attempt("Pruning alerts", () => deps.pruneAlerts(env, now));
  }
  await attempt("Delivering alerts", () => deps.deliverPending(env));
  await attempt("Pinging the heartbeat", () => deps.pingHeartbeat(env));
}
