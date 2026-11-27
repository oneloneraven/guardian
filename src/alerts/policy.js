/**
 * @typedef {{ kind: "fail" | "resolved" | "unknown" | "new-repository", target: string, subject: string, text: string }} Alert
 */

export const VISIBILITY_NOT_SET = "Expected visibility not set";

/**
 * @param {import("../results/store.js").Transition} transition
 * @param {{ title: string, adminUrl?: string }} meta
 * @returns {Alert | null}
 */
export function decide({ target, check, previous, status, reason, reasonChanged, unknownSweeps }, { title, adminUrl }) {
  const tail = adminUrl ? ` ${adminUrl}` : "";
  if (check === "visibility" && status === "unknown" && reason === VISIBILITY_NOT_SET) {
    return previous === null
      ? {
          kind: "new-repository",
          target,
          subject: check,
          text: `New repository ${target}: set its expected visibility.${tail}`,
        }
      : null;
  }
  if (status === "fail" && (previous !== "fail" || reasonChanged)) {
    return { kind: "fail", target, subject: check, text: `${target}: ${title} failed: ${reason}.${tail}` };
  }
  if (previous === "fail" && (status === "pass" || status === "skipped")) {
    return { kind: "resolved", target, subject: check, text: `${target}: ${title} resolved.${tail}` };
  }
  if (status === "unknown" && unknownSweeps === 2) {
    return {
      kind: "unknown",
      target,
      subject: check,
      text: `Guardian can't verify ${title} on ${target}: ${reason}.${tail}`,
    };
  }
  return null;
}
