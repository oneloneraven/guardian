/** @typedef {Node | string | null | undefined | false} Child */

/**
 * Builds an element. Strings become text nodes, so nothing passed in is ever parsed as markup.
 * @template {keyof HTMLElementTagNameMap} T
 * @param {T} tag
 * @param {Record<string, unknown> | null} [attributes]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElementTagNameMap[T]}
 */
export function h(tag, attributes, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith("on") && typeof value === "function") {
      element.addEventListener(name.slice(2).toLowerCase(), /** @type {EventListener} */ (value));
    } else if (name === "class") {
      element.className = String(value);
    } else if (value === true) {
      element.setAttribute(name, "");
    } else {
      element.setAttribute(name, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}
