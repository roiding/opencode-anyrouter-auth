import { cleanResponsesRequest, createFilteredFetch, defaultRetryDelay, fetchWithFilter,
  historyErrorCode, retryErrorClass } from "./lib/responses-filter.mjs";
import { resolveModelMetadata } from "./lib/model-metadata.mjs";
import { createModelRegistry } from "./lib/model-registry.mjs";
import { readBoundedText } from "./lib/site-client.mjs";

const DEFAULT_PROVIDER_ID = "auto-codex-filter";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
function normalizeBaseURL(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseURL must use http: or https:");
  }
  return url.href.replace(/\/+$/, "");
}

function normalizeModels(models) {
  const source = Array.isArray(models)
    ? Object.fromEntries(models.map(id => [String(id), { id: String(id) }]))
    : models && typeof models === "object" ? models : null;
  if (!source) return {};

  const result = {};
  for (const [key, value] of Object.entries(source)) {
    const model = typeof value === "string" ? { id: value } : { ...value };
    result[key] = {
      ...model,
      id: model.id ?? key,
      name: model.name ?? model.id ?? key
    };
  }
  return result;
}

async function plugin(input = {}, options = {}) {
  const providerId = options.providerId || DEFAULT_PROVIDER_ID;
  const models = normalizeModels(options.models);
  let explicit = { models };
  const loadRegistry = createModelRegistry(options.modelsRegistryPath ? { paths: [options.modelsRegistryPath] } : {});
  const configuredBaseURL = options.baseURL ? normalizeBaseURL(options.baseURL) : undefined;
  const accountBaseURL = auth => normalizeBaseURL(auth?.metadata?.baseURL || explicit.api || configuredBaseURL || DEFAULT_BASE_URL);
  const prompts = configuredBaseURL ? [] : [{
    type: "text",
    key: "baseURL",
    message: "Responses API base URL",
    placeholder: "https://api.example.com/v1",
    validate(value) {
      try {
        normalizeBaseURL(value);
        return undefined;
      } catch {
        return "Enter an http: or https: URL";
      }
    }
  }];

  return {
    config: async cfg => {
      cfg.provider ??= {};
      explicit = structuredClone(cfg.provider[providerId] ?? { models });
      cfg.provider[providerId] ??= {
        name: options.providerName || "Auto Codex Filter",
        npm: "@ai-sdk/openai",
        api: configuredBaseURL || DEFAULT_BASE_URL,
        models
      };
    },
    auth: {
      provider: providerId,
      maxConcurrency: options.maxConcurrency ?? 4,
      methods: [{
        type: "api",
        label: "Responses 上游 API key",
        placeholder: "sk-…（无鉴权的本地端点也请填一个非空占位符）",
        prompts
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        const baseURL = accountBaseURL(auth);
        const headers = new Headers();
        if (auth?.key) headers.set("authorization", `Bearer ${auth.key}`);
        const filtered = createFilteredFetch((request, init) => {
          const merged = new Headers(request instanceof Request ? request.headers : undefined);
          new Headers(init?.headers).forEach((value, name) => merged.set(name, value));
          headers.forEach((value, name) => merged.set(name, value));
          return fetch(request, { ...init, headers: merged });
        }, options.filter ?? {});
        return {
          baseURL,
          apiKey: auth?.key,
          fetch: filtered
        };
      }
    },
    provider: {
      id: providerId,
      async models(provider, { auth } = {}) {
        const fallback = () => {
          const result = Object.fromEntries(Object.entries(provider.models ?? {}).filter(([name]) => explicit.models?.[name] && !explicit.models[name].disabled)
            .map(([name, base]) => {
              const user = explicit.models[name];
              return [name, { ...base, ...resolveModelMetadata({ id: user.id || name, providerId, user, base }) }];
            }));
          result[Symbol.for("magpie.fellBack")] = true;
          return result;
        };
        try {
          const baseURL = accountBaseURL(auth);
          const headers = new Headers();
          if (auth?.key) headers.set("authorization", `Bearer ${auth.key}`);
          const response = await fetch(baseURL + "/models", { headers, redirect: "error", signal: AbortSignal.timeout(25000) });
          if (!response.ok) { await response.body?.cancel(); return fallback(); }
          const catalog = JSON.parse(await readBoundedText(response));
          if (!Array.isArray(catalog?.data)) return fallback();
          const registry = await loadRegistry();
          const rows = catalog.data.filter(model => typeof model?.id === "string" && model.id);
          for (const [name, user] of Object.entries(explicit.models ?? {})) {
            const id = user.id || name;
            if (!user.disabled && !rows.some(row => row.id === id)) rows.push({ id });
          }
          const result = {};
          for (const row of rows) {
            const aliases = Object.entries(explicit.models ?? {}).filter(([name, user]) => (user.id || name) === row.id);
            for (const [name, user] of aliases.length ? aliases : [[row.id, {}]]) {
              if (user.disabled) continue;
              const base = provider.models?.[name] ?? provider.models?.[row.id] ?? {};
              result[name] = {
                ...base, id: name, name: user.name || row.name || base.name || name,
                api: { ...base.api, id: row.id, url: user.provider?.api || baseURL, npm: user.provider?.npm || explicit.npm || "@ai-sdk/openai" },
                ...resolveModelMetadata({ id: row.id, providerId, registry, row, user, base }),
                options: { ...base.options, ...user.options }, headers: { ...base.headers, ...user.headers }
              };
            }
          }
          return result;
        } catch {
          return fallback();
        }
      }
    }
  };
}

export default {
  id: "auto-codex-filter",
  server: plugin
};

export const _internal = {
  cleanResponsesRequest,
  defaultRetryDelay,
  fetchWithFilter,
  historyErrorCode,
  normalizeModels,
  retryErrorClass
};
