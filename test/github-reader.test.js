import { expect, test } from "vitest";
import { ReadError, reader } from "../src/github/reader.js";

/** @param {string} text */
function toBase64(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** @param {Record<string, () => Response>} routes */
function stub(routes) {
  /** @type {string[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async input => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${url}`);
    return route();
  };
  return { calls, fetchImpl };
}

const BASE = "https://api.github.com";

/** @param {string} next */
const link = next => ({ Link: `<${next}>; rel="next", <${BASE}/last>; rel="last"` });

test("all follows Link headers across three pages", async () => {
  const { calls, fetchImpl } = stub({
    [`${BASE}/things`]: () => Response.json([1, 2], { headers: link(`${BASE}/things?page=2`) }),
    [`${BASE}/things?page=2`]: () => Response.json([3], { headers: link(`${BASE}/things?page=3`) }),
    [`${BASE}/things?page=3`]: () => Response.json([4, 5]),
  });
  expect(await reader("t", fetchImpl).all("/things")).toEqual({ status: 200, items: [1, 2, 3, 4, 5] });
  expect(calls).toHaveLength(3);
});

test("all returns the failing status of a later page", async () => {
  const { fetchImpl } = stub({
    [`${BASE}/things`]: () => Response.json([1, 2], { headers: link(`${BASE}/things?page=2`) }),
    [`${BASE}/things?page=2`]: () => new Response("slow down", { status: 403 }),
  });
  expect(await reader("t", fetchImpl).all("/things")).toEqual({ status: 403, items: [1, 2] });
});

test("all reads the array out of an object page such as { total_count, repositories: [...] }", async () => {
  const { fetchImpl } = stub({
    [`${BASE}/installation/repositories`]: () =>
      Response.json({ total_count: 2, repositories: [{ name: "a" }, { name: "b" }] }),
  });
  expect(await reader("t", fetchImpl).all("/installation/repositories")).toEqual({
    status: 200,
    items: [{ name: "a" }, { name: "b" }],
  });
});

test("get turns a timeout into status 0", async () => {
  /** @type {typeof fetch} */
  const hang = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  expect(await reader("t", hang, 20).get("/slow")).toEqual({ status: 0, body: null });
});

test("get sends the token and returns the parsed body", async () => {
  /** @type {Headers | undefined} */
  let sent;
  /** @type {typeof fetch} */
  const fetchImpl = async (_input, init) => {
    sent = new Headers(init?.headers);
    return Response.json({ ok: true });
  };
  expect(await reader("secret", fetchImpl).get("/x")).toEqual({ status: 200, body: { ok: true } });
  expect(sent?.get("Authorization")).toBe("Bearer secret");
  expect(sent?.get("User-Agent")).toBe("oneloneraven-guardian");
});

test("file decodes base64 content and returns its sha", async () => {
  const text = "# Café ☕ — naïve\n";
  const { calls, fetchImpl } = stub({
    [`${BASE}/repos/o/r/contents/docs/a%20b.md?ref=main`]: () =>
      Response.json({ content: `${toBase64(text).replace(/(.{20})/g, "$1\n")}\n`, sha: "abc123" }),
  });
  expect(await reader("t", fetchImpl).file("o/r", "docs/a b.md", "main")).toEqual({ text, sha: "abc123" });
  expect(calls).toHaveLength(1);
});

test("file is null on 404 and throws ReadError on 403", async () => {
  const { fetchImpl } = stub({
    [`${BASE}/repos/o/r/contents/missing.md`]: () => new Response("", { status: 404 }),
    [`${BASE}/repos/o/r/contents/secret.md`]: () => new Response("", { status: 403 }),
  });
  const read = reader("t", fetchImpl);
  expect(await read.file("o/r", "missing.md")).toBeNull();
  const error = await read.file("o/r", "secret.md").catch(caught => caught);
  expect(error).toBeInstanceOf(ReadError);
  expect(error).toMatchObject({ what: "secret.md", status: 403 });
});

test("blob decodes a git blob by sha", async () => {
  const text = "größe ✓";
  const { fetchImpl } = stub({
    [`${BASE}/repos/o/r/git/blobs/deadbeef`]: () => Response.json({ content: toBase64(text), encoding: "base64" }),
    [`${BASE}/repos/o/r/git/blobs/gone`]: () => new Response("", { status: 404 }),
    [`${BASE}/repos/o/r/git/blobs/nope`]: () => new Response("", { status: 500 }),
  });
  const read = reader("t", fetchImpl);
  expect(await read.blob("o/r", "deadbeef")).toBe(text);
  expect(await read.blob("o/r", "gone")).toBeNull();
  await expect(read.blob("o/r", "nope")).rejects.toMatchObject({ what: "nope", status: 500 });
});
