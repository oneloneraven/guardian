import { getEvents, getResults, getSettings } from "./api.js";
import { h } from "./dom.js";
import { renderSettings } from "./settings-page.js";

const root = /** @type {HTMLElement} */ (document.getElementById("settings"));

/**
 * @param {string} [section]
 * @param {string} [message]
 */
async function load(section, message) {
  try {
    const [settings, results, events] = await Promise.all([
      getSettings(),
      getResults().catch(() => null),
      getEvents().catch(() => null),
    ]);
    renderSettings(root, { settings, results, events, reload: load });
    if (section && message) {
      const target = root.querySelector(`#${section}`);
      const status = target?.querySelector(".saved");
      if (status) status.textContent = message;
      /** @type {HTMLElement | null | undefined} */ (target?.querySelector("h2"))?.focus();
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const status = section ? root.querySelector(`#${section} .saved`) : null;
    if (status) status.textContent = `${message} The page couldn't refresh: ${text}`;
    else root.replaceChildren(h("p", { class: "form-error", role: "alert" }, text));
  }
}

load();
