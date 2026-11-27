import { describeActor } from "../settings/store.js";
import {
  deleteException,
  deleteToken,
  Invalid,
  json,
  postException,
  postStandard,
  postToken,
  putNames,
  putRepository,
  readSettings,
} from "./settings-api.js";

/** @typedef {import("./settings-api.js").Context} Context */
/** @typedef {(context: Context, body: Record<string, unknown>, param: string) => Promise<Response>} Handler */

/** @type {{ pattern: RegExp, methods: Record<string, Handler> }[]} */
const ROUTES = [
  { pattern: /^\/api\/settings$/, methods: { GET: ({ env }) => readSettings(env).then(body => json(200, body)) } },
  { pattern: /^\/api\/owners$/, methods: { PUT: (context, body) => putNames(context, "owners", body) } },
  { pattern: /^\/api\/apps$/, methods: { PUT: (context, body) => putNames(context, "apps", body) } },
  {
    pattern: /^\/api\/repositories\/([^/]+)$/,
    methods: { PUT: (context, body, name) => putRepository(context, name, body) },
  },
  { pattern: /^\/api\/exceptions$/, methods: { POST: postException } },
  {
    pattern: /^\/api\/exceptions\/([^/]+)$/,
    methods: { DELETE: (context, _body, id) => deleteException(context, id) },
  },
  { pattern: /^\/api\/tokens$/, methods: { POST: postToken } },
  { pattern: /^\/api\/tokens\/([^/]+)$/, methods: { DELETE: (context, _body, id) => deleteToken(context, id) } },
  { pattern: /^\/api\/standard$/, methods: { POST: postStandard } },
];

/** @param {string} segment */
function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/**
 * @param {Request} request
 * @param {import("../settings/store.js").SettingsEnv} env
 * @returns {Promise<Record<string, unknown> | Response>}
 */
async function readBody(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && (!env.ADMIN_HOST || origin !== `https://${env.ADMIN_HOST}`)) {
    return json(403, { error: "Forbidden" });
  }
  if (request.method === "DELETE") return {};
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return json(415, { error: "body must be JSON" });
  }
  try {
    const body = await request.json();
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return json(400, { error: "body must be JSON" });
    return /** @type {Record<string, unknown>} */ (body);
  } catch {
    return json(400, { error: "body must be JSON" });
  }
}

/**
 * @param {Request} request
 * @param {import("../settings/store.js").SettingsEnv} env
 * @param {{ email: string }} identity
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Response>}
 */
export async function routeAdmin(request, env, identity, fetchImpl) {
  if (describeActor(env, identity.email) !== "the owner") return json(403, { error: "Forbidden" });
  const { pathname } = new URL(request.url);
  for (const { pattern, methods } of ROUTES) {
    const match = pattern.exec(pathname);
    if (!match) continue;
    const handler = methods[request.method];
    if (!handler) return json(405, { error: "Method not allowed" });
    const body = request.method === "GET" ? {} : await readBody(request, env);
    if (body instanceof Response) return body;
    try {
      return await handler({ env, email: identity.email, fetchImpl }, body, decode(match[1] ?? ""));
    } catch (error) {
      if (error instanceof Invalid) return json(400, { error: error.message });
      throw error;
    }
  }
  return json(404, { error: "Not found" });
}
