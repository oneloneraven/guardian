import * as api from "./api.js";
import { h } from "./dom.js";
import { checkException, checkPin, checkToken, describeChange, parseNames } from "./validate.js";

/** @typedef {import("./api.js").Settings} Settings */
/** @typedef {{ settings: Settings, reload: (section: string, message: string) => Promise<void> }} Page */
/** @typedef {{ name: string, label: string, hint?: string, type?: "input" | "textarea" | "select", options?: string[][], value?: string, autocomplete?: string }} FieldSpec */

/** @param {string} iso */
const when = iso =>
  new Date(iso.endsWith("Z") ? iso : `${iso}Z`).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/London",
  });

/**
 * @param {string} formId
 * @param {FieldSpec} spec
 */
function field(formId, { name, label, hint, type = "input", options = [], value = "", autocomplete = "off" }) {
  const id = `${formId}-${name}`;
  const errorId = `${id}-error`;
  const hintId = hint ? `${id}-hint` : null;
  const control =
    type === "select"
      ? h("select", { id, name }, ...options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)))
      : type === "textarea"
        ? h("textarea", { id, name, rows: 2, autocomplete, spellcheck: "false" }, value)
        : h("input", { id, name, type: "text", value, autocomplete, spellcheck: "false" });
  if (hintId) control.setAttribute("aria-describedby", hintId);
  return h(
    "div",
    { class: "field" },
    h("label", { for: id }, label),
    hint ? h("p", { id: hintId, class: "hint" }, hint) : null,
    control,
    h("p", { id: errorId, class: "field-error", hidden: true }),
  );
}

/**
 * @param {HTMLFormElement} form
 * @param {Record<string, string | undefined>} errors
 */
function showErrors(form, errors) {
  /** @type {HTMLElement | null} */
  let first = null;
  for (const control of form.querySelectorAll("input, select, textarea")) {
    const input = /** @type {HTMLInputElement} */ (control);
    const message = errors[input.name];
    const error = /** @type {HTMLElement} */ (form.querySelector(`#${input.id}-error`));
    const hint = form.querySelector(`#${input.id}-hint`);
    error.textContent = message ?? "";
    error.hidden = !message;
    const describedBy = [hint ? hint.id : null, message ? error.id : null].filter(Boolean).join(" ");
    if (describedBy) input.setAttribute("aria-describedby", describedBy);
    else input.removeAttribute("aria-describedby");
    if (message) {
      input.setAttribute("aria-invalid", "true");
      first ??= input;
    } else {
      input.removeAttribute("aria-invalid");
    }
  }
  first?.focus();
  return first === null;
}

/**
 * A form that checks its fields, sends them, and reloads the page's settings when the change is saved.
 * @param {Page} page
 * @param {{ id: string, section: string, fields: FieldSpec[], submit: string, check: (values: Record<string, string>) => Record<string, string | undefined>, send: (values: Record<string, string>) => Promise<unknown>, saved: string }} options
 */
function settingsForm(page, { id, section, fields, submit, check, send, saved }) {
  const failure = h("p", { class: "form-error", role: "alert" });
  const button = h("button", { type: "submit", class: "primary" }, submit);
  const form = h(
    "form",
    {
      id,
      novalidate: true,
      onsubmit: async (/** @type {SubmitEvent} */ event) => {
        event.preventDefault();
        failure.textContent = "";
        const data = new FormData(form);
        const values = Object.fromEntries(fields.map(f => [f.name, String(data.get(f.name) ?? "")]));
        if (!showErrors(form, check(values))) return;
        button.disabled = true;
        try {
          await send(values);
          await page.reload(section, saved);
        } catch (error) {
          failure.textContent = error instanceof Error ? error.message : String(error);
          button.disabled = false;
        }
      },
    },
    ...fields.map(spec => field(id, spec)),
    h("div", { class: "actions" }, button),
    failure,
  );
  return form;
}

/**
 * A remove button that asks inline before it removes anything.
 * @param {Page} page
 * @param {{ section: string, label: string, question: string, remove: () => Promise<unknown>, removed: string }} options
 */
function removeControl(page, { section, label, question, remove, removed }) {
  const wrapper = h("div", { class: "remove" });
  const failure = h("p", { class: "form-error", role: "alert" });
  const ask = () => {
    const keep = h("button", { type: "button", onclick: () => reset(true) }, "Keep it");
    const confirm = h(
      "button",
      {
        type: "button",
        class: "danger solid",
        onclick: async () => {
          confirm.disabled = true;
          try {
            await remove();
            await page.reload(section, removed);
          } catch (error) {
            failure.textContent = error instanceof Error ? error.message : String(error);
            confirm.disabled = false;
          }
        },
      },
      "Remove for good",
    );
    wrapper.replaceChildren(h("p", null, question), h("div", { class: "actions" }, confirm, keep), failure);
    keep.focus();
  };
  const reset = (/** @type {boolean} */ focus) => {
    const button = h("button", { type: "button", class: "danger", "aria-label": label, onclick: ask }, "Remove");
    wrapper.replaceChildren(button);
    if (focus) button.focus();
  };
  reset(false);
  return wrapper;
}

/**
 * @param {string} id
 * @param {string} title
 * @param {...(Node | string | null)} children
 */
const section = (id, title, ...children) =>
  h(
    "section",
    { id, "aria-labelledby": `${id}-title` },
    h("h2", { id: `${id}-title`, tabindex: "-1" }, title),
    h("p", { class: "saved", role: "status" }),
    ...children,
  );

/** @param {Page} page */
function standardSection(page) {
  const { standard } = page.settings;
  const state = !standard
    ? h("p", { class: "state attention" }, "No standard pinned: every check that needs it is Unknown.")
    : standard.unknown
      ? h("p", { class: "state attention" }, `${standard.version ?? "The pin"} isn't in use: ${standard.unknown}.`)
      : h("p", { class: "state" }, `Pinned to ${standard.version}.`);
  return section(
    "standard",
    "Standard",
    state,
    settingsForm(page, {
      id: "pin",
      section: "standard",
      fields: [
        { name: "version", label: "Bootstrap release", hint: "Its tag, such as v1.18.0." },
        { name: "sha256", label: "SHA-256 of its standard.json" },
      ],
      submit: "Pin this standard",
      check: values => checkPin({ version: values.version, sha256: values.sha256 }),
      send: values => api.pinStandard({ version: values.version.trim(), sha256: values.sha256.trim() }),
      saved: "Standard pinned.",
    }),
  );
}

/** @param {Page} page */
function alertsSection(page) {
  const { enabled } = page.settings.alerts;
  const failure = h("p", { class: "form-error", role: "alert" });
  const wrapper = h("div", { class: "remove" });
  /**
   * @param {boolean} next
   * @param {HTMLButtonElement} button
   */
  const change = async (next, button) => {
    button.disabled = true;
    failure.textContent = "";
    try {
      await api.putAlerts(next);
      await page.reload("alerts", next ? "Check alerts turned on." : "Check alerts turned off.");
    } catch (error) {
      failure.textContent = error instanceof Error ? error.message : String(error);
      button.disabled = false;
    }
  };
  const ask = () => {
    const keep = h("button", { type: "button", onclick: () => reset(true) }, "Keep them on");
    const confirm = h(
      "button",
      { type: "button", class: "danger solid", onclick: () => change(false, confirm) },
      "Turn them off",
    );
    wrapper.replaceChildren(
      h("p", null, "Turn check alerts off? Failures will still be recorded, but nothing will post to Discord."),
      h("div", { class: "actions" }, confirm, keep),
      failure,
    );
    keep.focus();
  };
  const reset = (/** @type {boolean} */ focus) => {
    const button = enabled
      ? h("button", { type: "button", class: "danger", onclick: ask }, "Turn check alerts off")
      : h("button", { type: "button", class: "primary", onclick: () => change(true, button) }, "Turn check alerts on");
    wrapper.replaceChildren(button, failure);
    if (focus) button.focus();
  };
  reset(false);
  return section(
    "alerts",
    "Alerts",
    h(
      "p",
      { class: enabled ? "state" : "state attention" },
      enabled
        ? "Check alerts are on: failures, resolutions and things Guardian can't verify post to Discord."
        : "Check alerts are off. Results are still recorded, and settings changes are always announced.",
    ),
    wrapper,
  );
}

/**
 * @param {Page} page
 * @param {"owners" | "apps"} key
 */
function namesForm(page, key) {
  const label = key === "owners" ? "Owners" : "Apps";
  return settingsForm(page, {
    id: key,
    section: "owners-and-apps",
    fields: [
      {
        name: "values",
        label: key === "owners" ? "Owners' GitHub logins" : "App slugs",
        hint: "Separate them with commas or new lines.",
        type: "textarea",
        value: page.settings[key].join(", "),
      },
    ],
    submit: key === "owners" ? "Save owners" : "Save Apps",
    check: values => {
      const parsed = parseNames(values.values);
      return "error" in parsed ? { values: parsed.error } : {};
    },
    send: values => {
      const parsed = parseNames(values.values);
      return api.putNames(key, "values" in parsed ? parsed.values : []);
    },
    saved: `${label} saved.`,
  });
}

const VISIBILITY = [
  ["public", "Public"],
  ["private", "Private"],
];

/** @param {Page} page */
function repositoriesSection(page) {
  const { repositories } = page.settings;
  const rows = repositories.length
    ? h(
        "ul",
        { class: "rows" },
        ...repositories.map(repository =>
          h(
            "li",
            { "data-repository": repository.name },
            h("p", { class: "row-title" }, repository.name),
            h(
              "p",
              { class: repository.expectedVisibility ? "muted" : "attention" },
              repository.expectedVisibility
                ? `Expected to be ${repository.expectedVisibility}.`
                : "Expected visibility not set: its visibility check is Unknown.",
            ),
          ),
        ),
      )
    : h("p", { class: "empty" }, "No repositories yet. Set one's expected visibility below.");
  return section(
    "repositories",
    "Repositories",
    rows,
    settingsForm(page, {
      id: "repository",
      section: "repositories",
      fields: [
        { name: "name", label: "Repository" },
        { name: "visibility", label: "Expected visibility", type: "select", options: VISIBILITY, value: "public" },
      ],
      submit: "Set visibility",
      check: values =>
        /^[A-Za-z0-9._-]{1,100}$/.test(values.name.trim()) ? {} : { name: "Give the repository's name." },
      send: values => api.putRepository(values.name.trim(), /** @type {"public" | "private"} */ (values.visibility)),
      saved: "Expected visibility saved.",
    }),
  );
}

/** @param {Page} page */
function exceptionsSection(page) {
  const { exceptions } = page.settings;
  const rows = exceptions.length
    ? h(
        "ul",
        { class: "rows" },
        ...exceptions.map(exception =>
          h(
            "li",
            { "data-exception": String(exception.id) },
            h("p", { class: "row-title" }, `${exception.check} on ${exception.target}`),
            exception.match ? h("p", { class: "muted" }, `Only where it matches ${exception.match}`) : null,
            h("p", null, exception.reason),
            removeControl(page, {
              section: "exceptions",
              label: `Remove the ${exception.check} exception on ${exception.target}`,
              question: `Remove the ${exception.check} exception on ${exception.target}? The check applies again.`,
              remove: () => api.removeException(exception.id),
              removed: "Exception removed.",
            }),
          ),
        ),
      )
    : h("p", { class: "empty" }, "No exceptions: every check applies everywhere.");
  return section(
    "exceptions",
    "Exceptions",
    rows,
    h("h3", null, "Add an exception"),
    settingsForm(page, {
      id: "exception",
      section: "exceptions",
      fields: [
        { name: "target", label: "Repository, or organisation" },
        { name: "check", label: "Check", hint: "Its id, such as secrets-known." },
        { name: "match", label: "Only where it matches (optional)", hint: "Such as a secret's name." },
        { name: "reason", label: "Reason", type: "textarea" },
      ],
      submit: "Add exception",
      check: values =>
        checkException({ target: values.target, check: values.check, match: values.match, reason: values.reason }),
      send: values =>
        api.addException({
          target: values.target.trim(),
          check: values.check.trim(),
          ...(values.match.trim() && { match: values.match.trim() }),
          reason: values.reason.trim(),
        }),
      saved: "Exception added.",
    }),
  );
}

/** @param {Page} page */
function tokensSection(page) {
  const { tokens } = page.settings;
  const rows = tokens.length
    ? h(
        "ul",
        { class: "rows" },
        ...tokens.map(token =>
          h(
            "li",
            { "data-token": token.tokenId },
            h("p", { class: "row-title" }, token.name),
            h("p", { class: "muted" }, token.repository ? `${token.tokenId} · ${token.repository}` : token.tokenId),
            h("p", null, token.purpose),
            removeControl(page, {
              section: "tokens",
              label: `Remove the token ${token.name}`,
              question: `Remove ${token.name}? Its actions will alert as unknown.`,
              remove: () => api.removeToken(token.tokenId),
              removed: "Token removed.",
            }),
          ),
        ),
      )
    : h("p", { class: "empty" }, "No known tokens. Add each one Bootstrap prints when it creates a token.");
  return section(
    "tokens",
    "Known tokens",
    rows,
    h("h3", null, "Add a token"),
    settingsForm(page, {
      id: "token",
      section: "tokens",
      fields: [
        { name: "tokenId", label: "Token id" },
        { name: "name", label: "Name" },
        { name: "purpose", label: "Purpose", type: "textarea" },
        { name: "repository", label: "Repository (optional)" },
      ],
      submit: "Add token",
      check: values =>
        checkToken({
          tokenId: values.tokenId,
          name: values.name,
          purpose: values.purpose,
          repository: values.repository,
        }),
      send: values =>
        api.addToken({
          tokenId: values.tokenId.trim(),
          name: values.name.trim(),
          purpose: values.purpose.trim(),
          ...(values.repository.trim() && { repository: values.repository.trim() }),
        }),
      saved: "Token added.",
    }),
  );
}

/** @param {Page} page */
function auditSection(page) {
  const { audit } = page.settings;
  return section(
    "audit",
    "Settings audit",
    audit.length
      ? h(
          "ol",
          { class: "rows" },
          ...audit.map(entry =>
            h(
              "li",
              { "data-audit": String(entry.id) },
              h("p", null, describeChange(entry)),
              h(
                "p",
                { class: "muted" },
                h("time", { datetime: entry.changedAt }, when(entry.changedAt)),
                entry.notified ? null : " · Not announced on Discord yet",
              ),
            ),
          ),
        )
      : h("p", { class: "empty" }, "No changes yet. Every change is listed here and announced on Discord."),
  );
}

/**
 * @param {HTMLElement} root
 * @param {Page} page
 */
export function renderSettings(root, page) {
  root.replaceChildren(
    standardSection(page),
    alertsSection(page),
    section(
      "owners-and-apps",
      "Owners and Apps",
      h("p", { class: "muted" }, "Who may own the organisation, and which Apps may be installed on it."),
      namesForm(page, "owners"),
      namesForm(page, "apps"),
    ),
    repositoriesSection(page),
    exceptionsSection(page),
    tokensSection(page),
    auditSection(page),
    section("results", "Results", h("p", { class: "empty" }, "Not watching yet.")),
    section("events", "Security events", h("p", { class: "empty" }, "Not watching yet.")),
  );
}
