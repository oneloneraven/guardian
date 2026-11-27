/**
 * @typedef {{ modules: string[], flags: Record<string, boolean>, skipped: Record<string, string> }} AcceptedRecord
 * @typedef {{ name: string, refs: string[] }} ExpectedEnvironment
 * @typedef {{
 *   environments: ExpectedEnvironment[],
 *   repositorySecrets: string[],
 *   environmentSecrets: Record<string, string[]>,
 *   apps: string[],
 *   securityFeatures: string[],
 *   actionsPermissions: object,
 *   ruleset: { name: string, expected: boolean },
 * }} Expected
 */

/**
 * @param {string} step
 * @param {Record<string, string>} skipped
 */
const stepSkipped = (step, skipped) => Object.keys(skipped).some(key => key === step || key.startsWith(`${step}-`));

export class RecordError extends Error {}

/** @param {unknown} value */
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The parts of a repository's record that Guardian trusts. Exceptions and visibility are deliberately not read.
 * @param {string} text
 * @returns {AcceptedRecord}
 */
export function parseRecord(text) {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RecordError("The record isn't valid JSON");
  }
  if (!isObject(parsed)) throw new RecordError("The record isn't an object");
  if (parsed.version !== 1) throw new RecordError(`Unsupported record version ${String(parsed.version)}`);
  if (!Array.isArray(parsed.modules) || !parsed.modules.every((/** @type {unknown} */ m) => typeof m === "string")) {
    throw new RecordError("The record's modules aren't a list of names");
  }
  /** @type {Record<string, boolean>} */
  const flags = {};
  if (isObject(parsed.flags)) for (const [key, value] of Object.entries(parsed.flags)) flags[key] = value === true;
  /** @type {Record<string, string>} */
  const skipped = {};
  if (isObject(parsed.skipped)) {
    for (const [key, value] of Object.entries(parsed.skipped)) skipped[key] = typeof value === "string" ? value : "";
  }
  return { modules: parsed.modules, flags, skipped };
}

/**
 * @param {string | string[] | undefined} when
 * @param {Record<string, boolean>} flags
 * @returns {boolean}
 */
export function whenHolds(when, flags) {
  if (when === undefined) return true;
  if (Array.isArray(when)) return when.some(element => whenHolds(element, flags));
  return when.startsWith("!") ? !flags[when.slice(1)] : Boolean(flags[when]);
}

/**
 * @param {{ standard: any, record: AcceptedRecord | null, repo: string, owner: string, visibility: "public" | "private", plan: string | null }} input
 * @returns {Expected}
 */
export function expectedFor({ standard, record, repo, owner, visibility, plan }) {
  const modules = record?.modules ?? [];
  const flags = record?.flags ?? {};
  const skipped = record?.skipped ?? {};
  const shortName = repo.split("/").pop() ?? repo;
  /** @param {string} template */
  const fill = template => template.replaceAll("{repo}", shortName).replaceAll("{owner}", owner);
  /** @param {string} section */
  const entries = section =>
    modules.flatMap(module =>
      (standard.expected[section]?.[module] ?? []).filter((/** @type {{ when?: string | string[] }} */ entry) =>
        whenHolds(entry.when, flags),
      ),
    );

  /** @type {any[]} */
  const environmentEntries = entries("environments");
  const skippedEnvironments = new Set(
    environmentEntries.filter(entry => entry.step && stepSkipped(entry.step, skipped)).map(entry => entry.name),
  );

  const environments = environmentEntries
    .filter(entry => !skippedEnvironments.has(entry.name))
    .map(entry => ({
      name: entry.name,
      refs: entry.refs
        .filter(
          (/** @type {string | { when?: string | string[] }} */ ref) =>
            typeof ref === "string" || whenHolds(ref.when, flags),
        )
        .map((/** @type {string | { ref: string }} */ ref) => (typeof ref === "string" ? ref : ref.ref)),
    }));

  /** @type {Set<string>} */
  const repositorySecrets = new Set();
  /** @type {Record<string, Set<string>>} */
  const byEnvironment = {};
  for (const secret of /** @type {any[]} */ (entries("secrets"))) {
    const inEnvironment =
      secret.scope === "environment" && secret.environment && !skippedEnvironments.has(secret.environment);
    if (!inEnvironment) {
      repositorySecrets.add(secret.name);
      continue;
    }
    byEnvironment[secret.environment] ??= new Set();
    byEnvironment[secret.environment].add(secret.name);
  }

  const notExpected = standard.checks.find(
    (/** @type {{ kind: string }} */ check) => check.kind === "ruleset-enforced",
  )?.notExpected;
  const rulesetOff =
    Boolean(notExpected) && notExpected.visibility === visibility && (notExpected.plans ?? []).includes(plan);

  return {
    environments,
    repositorySecrets: [...repositorySecrets],
    environmentSecrets: Object.fromEntries(Object.entries(byEnvironment).map(([name, names]) => [name, [...names]])),
    apps: entries("apps").map((/** @type {{ slug: string }} */ app) => fill(app.slug)),
    securityFeatures: standard.expected.securityFeatures[visibility] ?? [],
    actionsPermissions: standard.expected.actionsPermissions,
    ruleset: { name: standard.expected.ruleset.name, expected: !rulesetOff },
  };
}
