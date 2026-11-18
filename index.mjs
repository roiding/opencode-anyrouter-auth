import { createProvider } from "./lib/provider.mjs";
import { PROVIDER } from "./lib/accounts.mjs";
import { createFilteredFetch, normalizeFilterOptions, _internal as filter } from "./lib/responses-filter.mjs";

async function plugin(input = {}, options = {}) {
  const settings = normalizeFilterOptions({
    retryProfile: "anyrouter",
    ...(options.filter ?? {})
  });
  const hooks = await createProvider(input, options);
  const originalLoader = hooks.auth.loader;

  const onEvent = (event, data) => {
    const result = input.client?.app?.log?.({ body: {
      service: "anyrouter-auto-filter",
      level: event.endsWith("error") || event === "cleanup-refused" ? "warn" : "info",
      message: event,
      extra: data
    } });
    result?.catch?.(() => {});
  };

  hooks.auth.options = [...(hooks.auth.options ?? []), {
    key: "conditional-history-filter",
    label: "安全重试加密历史错误",
    description: "先保留完整历史，只对明确的可移植历史错误做清理；支持的推理 SSE 先缓冲再交付。",
    default: true
  }];
  hooks.auth.loader = async (getAuth, provider) => {
    const loaded = await originalLoader(getAuth, provider);
    if (!loaded.fetch) return loaded;
    const filtered = createFilteredFetch(loaded.fetch.bind(loaded), { ...settings, onEvent });
    return {
      ...loaded,
      fetch(request, init) {
        const enabled = settings.enabled && input.magpie?.option?.(
          PROVIDER, "conditional-history-filter"
        ) !== false;
        if (!enabled) return loaded.fetch(request, init);
        if (!(request instanceof Request)) return filtered(request, init);
        const headers = new Headers(request.headers);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        return filtered(request, { ...init, headers });
      }
    };
  };

  return hooks;
}

export default { id: "opencode-anyrouter-auth", server: plugin };
export const _internal = { ...filter };
