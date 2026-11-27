import { getSettings } from "./api.js";
import { h } from "./dom.js";
import { renderSettings } from "./settings-page.js";

const root = /** @type {HTMLElement} */ (document.getElementById("settings"));

/**
 * @param {string} [section]
 * @param {string} [message]
 */
async function load(section, message) {
  try {
    const settings = await getSettings();
    renderSettings(root, { settings, reload: load });
    if (section && message) {
      const target = root.querySelector(`#${section}`);
      const status = target?.querySelector(".saved");
      if (status) status.textContent = message;
      /** @type {HTMLElement | null | undefined} */ (target?.querySelector("h2"))?.focus();
    }
  } catch (error) {
    root.replaceChildren(
      h("p", { class: "form-error", role: "alert" }, error instanceof Error ? error.message : String(error)),
    );
  }
}

load();
