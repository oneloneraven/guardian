import { loadStandard } from "../standard/pin.js";
import { raise } from "./outbox.js";
import { decide } from "./policy.js";

/**
 * @param {import("../settings/store.js").SettingsEnv} env
 * @param {import("../results/store.js").Transition[]} transitions
 * @returns {Promise<number>}
 */
export async function raiseFor(env, transitions) {
  const loaded = await loadStandard(env);
  /** @type {Map<string, string>} */
  const titles = new Map([
    ["record-accepted", "Accepted record"],
    ["audit-log", "Cloudflare audit log"],
  ]);
  if ("standard" in loaded) {
    for (const check of /** @type {{ id: string, title?: string }[]} */ (loaded.standard.checks ?? [])) {
      if (check.title && !titles.has(check.id)) titles.set(check.id, check.title);
    }
  }
  const adminUrl = env.ADMIN_HOST ? `https://${env.ADMIN_HOST}/` : undefined;
  let raised = 0;
  for (const transition of transitions) {
    const alert = decide(transition, { title: titles.get(transition.check) ?? transition.check, adminUrl });
    if (!alert) continue;
    if (await raise(env, alert)) raised++;
  }
  return raised;
}
