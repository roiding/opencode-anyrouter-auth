import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readBoundedText } from "./site-client.mjs";

export const REGISTRY_URL = "https://models.dev/api.json";
const MAX_BYTES = 32 * 1024 * 1024;
const valid = value => value && typeof value === "object" && !Array.isArray(value) &&
  Object.values(value).some(provider => provider?.models && typeof provider.models === "object" && !Array.isArray(provider.models));

export function registryCachePaths(env = process.env, home = homedir()) {
  const roots = [env.XDG_CACHE_HOME || join(home, ".cache"), env.LOCALAPPDATA].filter(Boolean);
  return [...new Set(roots)].flatMap(root => ["magpie", "opencode"].map(app => join(root, app, "models.json")));
}

async function readCache(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    const chunks = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) return undefined;
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (valid(value)) return value;
  } finally { await file.close(); }
}

// This is capability data, not an account catalog. Read the host's raw cache
// (its normalized model objects lose reasoning_options), never rewrite it.
export function createModelRegistry({ paths = registryCachePaths(), fetchImpl = (...args) => fetch(...args), now = Date.now,
  ttlMs = 300000, timeoutMs = 5000 } = {}) {
  let cached = {}, expires = 0, pending;
  return async () => {
    if (now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        for (const path of paths) {
          try {
            const value = await readCache(path);
            if (value) { cached = value; return cached; }
          } catch {}
        }
        const response = await fetchImpl(REGISTRY_URL, {
          headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) { await response.body?.cancel(); return cached; }
        const value = JSON.parse(await readBoundedText(response, MAX_BYTES));
        if (valid(value)) cached = value;
      } catch {}
      return cached;
    })();
    try { return await pending; }
    finally { expires = now() + ttlMs; pending = undefined; }
  };
}
