import { GithubUnavailable, installationToken } from "../github/app.js";
import { reader as githubReader, ReadError } from "../github/reader.js";
import { saveResult } from "../results/store.js";
import { loadStandard } from "../standard/pin.js";
import { expectedFor, parseRecord } from "./expected.js";
import { ORGANISATION_KINDS } from "./organisation.js";
import { REPOSITORY_KINDS } from "./repository.js";
import { list, unreadable } from "./result.js";

/**
 * @typedef {import("../github/reader.js").Reader} Reader
 * @typedef {import("../results/store.js").Transition} Transition
 * @typedef {import("./result.js").Result} Result
 * @typedef {import("../settings/store.js").SettingsEnv & { GITHUB_ORG?: string, GITHUB_APP_ID?: string, GITHUB_APP_PRIVATE_KEY?: string }} RunEnv
 * @typedef {"event" | "sweep" | "daily"} By
 * @typedef {{ id: string, kind: string | null }} CheckRef
 * @typedef {{ check_id: string, match: string | null, reason: string }} ExceptionRow
 */

const DEFAULT_ORG = "oneloneraven";
const ORGANISATION = "organisation";
const RECORD_PATH = ".bootstrap/record.json";
const RECORD_CHECK = "record-accepted";
const ACCEPTED_UNREADABLE = "The accepted record can't be read";

/** @param {RunEnv} env */
const orgOf = env => env.GITHUB_ORG || DEFAULT_ORG;

/** @param {string} reason @returns {Result} */
const unknown = reason => ({ status: "unknown", reason, link: null });

/**
 * @param {RunEnv} env
 * @param {"owners" | "apps"} key
 * @returns {Promise<string[]>}
 */
async function readNames(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first();
  try {
    const value = JSON.parse(String(row?.value));
    return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * @param {RunEnv} env
 * @param {any} standard
 * @param {"repository" | "organisation"} scope
 * @param {string} target
 * @returns {Promise<CheckRef[]>}
 */
async function checkList(env, standard, scope, target) {
  /** @type {CheckRef[]} */
  let checks;
  if ("standard" in standard) {
    checks = standard.standard.checks
      .filter((/** @type {any} */ check) => check.group === "security" && check.scope === scope)
      .map((/** @type {any} */ check) => ({ id: check.id, kind: check.kind }));
  } else {
    const { results } = await env.DB.prepare("SELECT check_id FROM results WHERE target = ?1").bind(target).all();
    checks = results.map(row => ({ id: String(row.check_id), kind: null }));
  }
  if (scope === "repository" && !checks.some(check => check.id === RECORD_CHECK)) {
    checks.push({ id: RECORD_CHECK, kind: RECORD_CHECK });
  }
  return checks;
}

/**
 * @param {RunEnv} env
 * @param {string} target
 * @param {CheckRef[]} checks
 * @param {string} reason
 * @param {By} by
 */
function saveAllUnknown(env, target, checks, reason, by) {
  return saveEach(env, target, checks, async () => unknown(reason), by);
}

/**
 * @param {RunEnv} env
 * @param {string} target
 * @param {CheckRef[]} checks
 * @param {(check: CheckRef) => Promise<Result>} decide
 * @param {By} by
 * @returns {Promise<Transition[]>}
 */
async function saveEach(env, target, checks, decide, by) {
  /** @type {Transition[]} */
  const transitions = [];
  for (const check of checks) {
    transitions.push(
      await saveResult(env, { target, check: check.id, result: await decide(check), by, at: new Date().toISOString() }),
    );
  }
  return transitions;
}

/**
 * @template Context
 * @param {CheckRef} check
 * @param {Record<string, (ctx: Context) => Promise<Result>>} kinds
 * @param {Context} ctx
 * @param {ExceptionRow[]} exceptions
 * @returns {Promise<Result>}
 */
async function runCheck(check, kinds, ctx, exceptions) {
  const mine = exceptions.filter(exception => exception.check_id === check.id);
  const skip = mine.find(exception => exception.match === null);
  if (skip) return { status: "skipped", reason: skip.reason, link: null };
  const run = check.kind ? kinds[check.kind] : undefined;
  if (!run) return unknown(`Guardian doesn't know the check kind \`${check.kind}\``);
  const matched = mine.filter(exception => exception.match !== null);
  try {
    return await run({
      ...ctx,
      exempt: (/** @type {string} */ match) => matched.find(e => e.match === match)?.reason ?? null,
    });
  } catch {
    return unknown("The check couldn't run");
  }
}

/**
 * @param {RunEnv} env
 * @param {string} target
 * @returns {Promise<ExceptionRow[]>}
 */
async function loadExceptions(env, target) {
  const { results } = await env.DB.prepare(
    "SELECT check_id, match, reason FROM exceptions WHERE target = ?1 ORDER BY id",
  )
    .bind(target)
    .all();
  return /** @type {ExceptionRow[]} */ (/** @type {unknown} */ (results));
}

/**
 * @param {Reader} read
 * @param {string} repo
 * @param {string | null} sha
 * @returns {Promise<import("./expected.js").AcceptedRecord | null | "unreadable">}
 */
async function acceptedRecord(read, repo, sha) {
  if (!sha) return null;
  try {
    const text = await read.blob(repo, sha);
    return text === null ? "unreadable" : parseRecord(text);
  } catch {
    return "unreadable";
  }
}

/**
 * @param {RunEnv} env
 * @param {Reader} read
 * @param {string} name
 * @param {By} by
 * @returns {Promise<Transition[]>}
 */
export async function checkRepository(env, read, name, by) {
  const org = orgOf(env);
  const repo = `${org}/${name}`;
  const standard = await loadStandard(env);
  await env.DB.prepare("INSERT OR IGNORE INTO repositories (name) VALUES (?1)").bind(name).run();
  const checks = await checkList(env, standard, "repository", name);
  if ("unknown" in standard) return saveAllUnknown(env, name, checks, standard.unknown, by);

  const { status, body: live } = await read.get(`/repos/${repo}`);
  if (status !== 200) {
    return saveAllUnknown(env, name, checks, unreadable("the repository", status, "Metadata read"), by);
  }
  const row = await env.DB.prepare("SELECT expected_visibility, accepted_record_sha FROM repositories WHERE name = ?1")
    .bind(name)
    .first();
  const [owners, exceptions, organisation] = await Promise.all([
    readNames(env, "owners"),
    loadExceptions(env, name),
    read.get(`/orgs/${org}`),
  ]);
  const plan = String(organisation.body?.plan?.name ?? "").toLowerCase() || null;

  /** @type {{ sha: string, text: string } | null} */
  let liveRecord = null;
  /** @type {string | null} */
  let recordFailure = null;
  try {
    liveRecord = await read.file(repo, RECORD_PATH, live.default_branch);
  } catch (error) {
    recordFailure = unreadable("the record", error instanceof ReadError ? error.status : 0, "Contents read");
  }

  const acceptedSha = row?.accepted_record_sha ? String(row.accepted_record_sha) : null;
  const accepted = await acceptedRecord(read, repo, acceptedSha);
  const expectedVisibility = /** @type {"public" | "private" | null} */ (row?.expected_visibility ?? null);
  const expected =
    accepted === "unreadable"
      ? { unknown: ACCEPTED_UNREADABLE }
      : expectedFor({
          standard: standard.standard,
          record: accepted,
          repo: name,
          owner: org,
          visibility: (expectedVisibility ?? live.visibility) === "public" ? "public" : "private",
          plan,
        });

  const ctx = { read, repo, live, expected, owners, expectedVisibility, acceptedSha, liveRecord, exempt: () => null };
  return saveEach(
    env,
    name,
    checks,
    async check => {
      const result = await runCheck(check, REPOSITORY_KINDS, ctx, exceptions);
      return check.id === RECORD_CHECK && recordFailure && result.status !== "skipped"
        ? unknown(recordFailure)
        : result;
    },
    by,
  );
}

/**
 * @param {RunEnv} env
 * @param {Reader} read
 * @param {By} by
 * @returns {Promise<Transition[]>}
 */
export async function checkOrganisation(env, read, by) {
  const org = orgOf(env);
  const standard = await loadStandard(env);
  const checks = await checkList(env, standard, "organisation", ORGANISATION);
  if ("unknown" in standard) return saveAllUnknown(env, ORGANISATION, checks, standard.unknown, by);

  const { status, body: live } = await read.get(`/orgs/${org}`);
  if (status !== 200) {
    return saveAllUnknown(env, ORGANISATION, checks, unreadable("the organisation", status, "Metadata read"), by);
  }
  const [owners, apps, exceptions, known] = await Promise.all([
    readNames(env, "owners"),
    readNames(env, "apps"),
    loadExceptions(env, ORGANISATION),
    env.DB.prepare("SELECT name, accepted_record_sha FROM repositories ORDER BY name").all(),
  ]);
  const repositories = [];
  for (const { name, accepted_record_sha: sha } of known.results) {
    const accepted = await acceptedRecord(read, `${org}/${name}`, sha ? String(sha) : null);
    repositories.push({ name: String(name), modules: accepted && accepted !== "unreadable" ? accepted.modules : [] });
  }
  const ctx = { read, org, live, standard: standard.standard, owners, apps, repositories, exempt: () => null };
  return saveEach(env, ORGANISATION, checks, check => runCheck(check, ORGANISATION_KINDS, ctx, exceptions), by);
}

/**
 * @param {RunEnv} env
 * @param {By} by
 * @param {{ readerFor?: () => Promise<Reader> }} [options]
 * @returns {Promise<{ checked: number, unknown: string | null }>}
 */
export async function sweep(env, by, { readerFor } = {}) {
  const standard = await loadStandard(env);
  /** @type {Reader} */
  let read;
  try {
    read = readerFor ? await readerFor() : githubReader(await installationToken(env));
  } catch (error) {
    if (!(error instanceof GithubUnavailable)) throw error;
    const reason = `Guardian can't reach GitHub: ${error.message}`;
    const { results } = await env.DB.prepare("SELECT name FROM repositories ORDER BY name").all();
    let checked = 0;
    for (const target of [ORGANISATION, ...results.map(row => String(row.name))]) {
      const scope = target === ORGANISATION ? "organisation" : "repository";
      const checks = await checkList(env, standard, scope, target);
      checked += (await saveAllUnknown(env, target, checks, reason, by)).length;
    }
    return { checked, unknown: reason };
  }

  const installed = await list(read, "/installation/repositories", "the installed repositories", "Metadata read");
  const names = "items" in installed ? installed.items.map(item => String(item.name)) : [];
  if (names.length > 0) {
    await env.DB.batch(
      names.map(name => env.DB.prepare("INSERT OR IGNORE INTO repositories (name) VALUES (?1)").bind(name)),
    );
  }
  let checked = (await checkOrganisation(env, read, by)).length;
  if ("unreadable" in installed) {
    const { results } = await env.DB.prepare("SELECT name FROM repositories ORDER BY name").all();
    for (const { name } of results) {
      const checks = await checkList(env, standard, "repository", String(name));
      checked += (await saveAllUnknown(env, String(name), checks, installed.unreadable, by)).length;
    }
  }
  for (const name of names) checked += (await checkRepository(env, read, name, by)).length;
  return {
    checked,
    unknown: "unknown" in standard ? standard.unknown : "unreadable" in installed ? installed.unreadable : null,
  };
}
