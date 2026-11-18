import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createModelRegistry, REGISTRY_URL, registryCachePaths } from "../lib/model-registry.mjs";

const fixture = fileURLToPath(new URL("./fixtures/models.json", import.meta.url));
const registry = JSON.parse(await readFile(fixture, "utf8"));

test("registry reads raw cache without writes or network, coalesces requests, and reloads", async t => {
  const dir = await mkdtemp(join(tmpdir(), "anyrouter-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "models.json");
  const text = JSON.stringify(registry);
  await writeFile(path, text);
  let now = 0;
  const load = createModelRegistry({ paths: [path], now: () => now, ttlMs: 100,
    fetchImpl: () => { assert.fail("A valid host cache must not cause a remote request"); } });
  const [a, b] = await Promise.all([load(), load()]);
  assert.deepEqual(a, registry);
  assert.equal(a, b);
  assert.equal(await readFile(path, "utf8"), text);
  const updated = { openai: { models: { changed: { reasoning: false } } } };
  await writeFile(path, JSON.stringify(updated));
  assert.equal(await load(), a);
  now = 101;
  assert.deepEqual(await load(), updated);
});

test("registry network fallback is bounded, anonymous, cached and single-flight", async () => {
  const calls = [];
  const load = createModelRegistry({ paths: [], fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return Response.json(registry);
  } });
  await Promise.all([load(), load(), load()]);
  assert.deepEqual(await load(), registry);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, REGISTRY_URL);
  assert.deepEqual(calls[0].init.headers, { accept: "application/json" });
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("registry failure preserves last successful data without leaking credential headers", async () => {
  let now = 0, calls = 0;
  const load = createModelRegistry({ paths: [], now: () => now, ttlMs: 100, fetchImpl: async () => {
    if (++calls === 1) return Response.json(registry);
    throw new Error("offline");
  } });
  await load();
  now = 101;
  assert.deepEqual(await load(), registry);
  assert.equal(calls, 2);
  const empty = createModelRegistry({ paths: [], fetchImpl: async () => Response.json({ data: [{ id: "not-a-registry" }] }) });
  assert.deepEqual(await empty(), {});
});

test("registry cache paths honor XDG and Windows cache locations without Codex catalog writes", () => {
  assert.deepEqual(registryCachePaths({ XDG_CACHE_HOME: "/cache" }, "/home/test"), ["/cache/magpie/models.json", "/cache/opencode/models.json"]);
  assert.ok(registryCachePaths({}, "/home/test").every(path => !path.includes(".codex")));
});
