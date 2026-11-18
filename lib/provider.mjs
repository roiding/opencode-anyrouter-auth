import { readFileSync } from "node:fs";

import {
  API_ENDPOINTS,
  PROVIDER,
  SITES,
  accountCapabilities,
  apiEndpointChoice,
  beijingDay,
  protocolBase,
  readAccount,
  saveAccount
} from "./accounts.mjs";
import { createSiteClient, quotaNumber } from "./site-client.mjs";
import { MODEL_HINT_HEADER, customHeaders, inferenceHeaders } from "./headers.mjs";
import { createCatalog, protocolOfURL } from "./catalog.mjs";
import { createModelRegistry } from "./model-registry.mjs";

const required = value => typeof value === "string" && value.length ? undefined : "This field is required.";
const advanced = { key: "advanced", op: "eq", value: "yes" };
const SESSION_MODES = new Set(["github", "linuxdo", "session"]);
const PLUGIN_ICON = `data:image/png;base64,${readFileSync(new URL("../icon.png", import.meta.url)).toString("base64")}`;

function prompts(mode) {
  const out = [];
  if (mode === "api-key") {
    out.push({
      type: "text",
      key: "email",
      message: "账号邮箱（可选，不是显示别名）",
      placeholder: "模型 key 无法查询账号身份；显示别名请在添加后使用 Magpie 原生改名",
      validate: value => !value?.trim() || /^[^\s@]+@[^\s@]+$/.test(value.trim()) ? undefined : "请输入账号邮箱；显示别名请在添加后设置。"
    });
  }
  if (mode === "password") {
    out.push(
      {
        type: "select",
        key: "checkinEnabled",
        message: "开启每日自动签到？这会把 AnyRouter 站点密码保存在本地。",
        options: [
          { label: "否 - 只用这次，不保存密码", value: "no" },
          { label: "是 - 保存密码用于每日签到", value: "yes" }
        ]
      },
      { type: "text", key: "username", message: "AnyRouter 站点用户名或邮箱", validate: required },
      { type: "password", key: "password", message: "AnyRouter 站点密码（不是 GitHub 或 LinuxDO 密码）", validate: required }
    );
  }
  if (SESSION_MODES.has(mode)) {
    out.push({
      type: "select",
      key: "checkinEnabled",
      message: "使用这个站点会话执行每日签到？会话过期后需要重新导入。",
      options: [
        { label: "否 - 只用于账号信息和模型连接", value: "no" },
        { label: "是 - 保存会话用于每日签到", value: "yes" }
      ]
    });
  }
  if (mode === "access-token") {
    out.push(
      { type: "password", key: "accessToken", message: "AnyRouter 系统访问令牌（不是模型 API key）", validate: required },
      { type: "text", key: "userId", message: "AnyRouter user ID (New-Api-User)", validate: value => /^\d+$/.test(value) ? undefined : "请输入数字形式的站点用户 ID。" }
    );
  }
  out.push({
    type: "select",
    key: "apiEndpoint",
    message: "模型 API 端点",
    options: [
      { label: "anyrouter.top（默认）", value: "top" },
      { label: "a-ocnfniawgw.cn-shanghai.fcapp.run（备用 API）", value: "fcapp" }
    ]
  });
  out.push({
    type: "select",
    key: "advanced",
    message: "展开高级账号设置？供应商/模型原生请求头始终可用。",
    options: [{ label: "否", value: "no" }, { label: "是", value: "yes" }]
  });
  if (mode !== "api-key") {
    out.push({
      type: "text",
      key: "keyId",
      message: "使用指定的 API key ID（只有一个可用 key 时可留空）",
      when: advanced,
      validate: value => !value || /^\d+$/.test(value) ? undefined : "请输入数字形式的 API key ID。"
    });
  }
  out.push(
    {
      type: "text",
      key: "headers",
      message: "自定义请求头（可选，每行一条 Name: value）",
      when: advanced,
      validate: value => {
        try {
          customHeaders(value);
        } catch (error) {
          return error.message;
        }
      }
    }
  );
  return out;
}

function accountFromInputs(mode, inputs = {}) {
  const checkinEnabled = (mode === "password" || SESSION_MODES.has(mode)) && inputs.checkinEnabled === "yes";
  const apiEndpoint = apiEndpointChoice(inputs.apiEndpoint || "top");
  const account = {
    mode,
    site: "top",
    siteURL: SITES.top,
    apiBase: protocolBase(API_ENDPOINTS[apiEndpoint]),
    key: "",
    keyId: inputs.keyId || "",
    label: String(inputs.label ?? inputs.email ?? "").trim(),
    email: "",
    username: mode === "password" ? String(inputs.username || "").trim() : "",
    password: mode === "password" ? inputs.password || "" : "",
    session: "",
    accessToken: mode === "access-token" ? String(inputs.accessToken || "").trim() : "",
    userId: mode === "access-token" ? String(inputs.userId || "").trim() : "",
    headers: inputs.headers || "",
    checkinEnabled
  };
  customHeaders(account.headers);
  return account;
}

const failed = error => ({ type: "failed", error: error.message || "站点未能完成登录。" });

function requestURL(request, init, headers, account, provider, explicit) {
  const original = new URL(request instanceof Request ? request.url : String(request));
  const protocol = protocolOfURL(original.href);
  if (!protocol) return original.href;
  let id = headers.get(MODEL_HINT_HEADER);
  if (!id && init.body) {
    try {
      const body = typeof init.body === "string"
        ? init.body
        : ArrayBuffer.isView(init.body) ? new TextDecoder().decode(init.body) : "";
      const model = JSON.parse(body).model;
      if (typeof model === "string") id = model;
    } catch {}
  }
  if (!id && protocol === "gemini") {
    id = decodeURIComponent(original.pathname.match(/\/models\/([^/]+):[^/]+$/)?.[1] || "");
  }
  const [name, model] = Object.entries(provider.models ?? {})
    .find(([name, model]) => name === id || model.api?.id === id) ?? [id, null];
  const user = explicit.models?.[name] ||
    Object.entries(explicit.models ?? {}).find(([name, model]) => (model.id || name) === id)?.[1];
  const isOfficial = value => [...Object.values(SITES), ...Object.values(API_ENDPOINTS)].includes(new URL(value).origin);
  const isDefaultSiteBase = value => {
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/\/+$/, "");
    return isOfficial(value) && ["", "/", "/v1", "/v1beta"].includes(path);
  };
  const userModelBase = user?.provider?.api || "";
  const catalogModelBase = model?.api?.url || "";
  const modelBase = userModelBase ||
    (catalogModelBase && !isDefaultSiteBase(catalogModelBase) ? catalogModelBase : "");
  const accountApiBase = account.apiBase && isDefaultSiteBase(account.apiBase)
    ? protocolBase(account.apiBase, protocol)
    : account.apiBase;
  const configuredBase = accountApiBase ||
    (explicit.api && !isDefaultSiteBase(explicit.api) ? explicit.api : "");
  const override = modelBase || configuredBase || protocolBase(account.siteURL, protocol);
  const base = override.replace(/\/+$/, "");
  if (original.href.startsWith(base + "/")) return original.href;
  const suffix = original.pathname.match(/\/(?:responses|chat\/completions|messages)\/?$|\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/)?.[0];
  return base + suffix + original.search;
}

function checkinFailure(error) {
  const kind = error?.kind;
  const outcome = kind === "captcha" || kind === "waf" ? "captcha"
    : kind === "credentials" || kind === "forbidden" ? "ineligible"
      : kind === "inactive" ? "inactive"
        : kind === "already" ? "done"
          : "failed";
  return { outcome, message: error?.message || "AnyRouter 签到失败。" };
}

export async function createProvider(input = {}, options = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || ((...args) => fetch(...args));
  const now = dependencies.now || Date.now;
  const site = createSiteClient({
    fetchImpl,
    now,
    timeoutMs: options.siteTimeoutMs ?? 30000
  });
  let explicit = {};
  const compatibility = () => input.magpie?.option?.(PROVIDER, "send-codex-headers") !== false;
  const loadRegistry = dependencies.loadRegistry || createModelRegistry({
    fetchImpl,
    ...(options.modelsRegistryPath ? { paths: [options.modelsRegistryPath] } : {})
  });
  const catalog = createCatalog({
    site,
    explicit: () => explicit,
    compatibility,
    fetchImpl,
    loadRegistry
  });
  const pending = new Map();
  const completed = new Map();
  const quotaPerUnit = options.quotaPerUnit ?? 500000;
  if (typeof quotaPerUnit !== "number" || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) {
    throw new Error("quotaPerUnit must be a positive number.");
  }

  async function finishLogin(result, selection) {
    const account = result.profileVerified
      ? result.account
      : (await site.profile(result.account)).account;
    const key = await site.selectKey(account, selection);
    const state = { ...account, ...key };
    const { type, ...record } = saveAccount(state);
    return { type: "success", ...record };
  }

  const methods = [
    {
      type: "api",
      keyless: true,
      label: "AnyRouter 账号密码（可处理 acw_sc__v2 JS 盾；Turnstile 需浏览器；可选签到）",
      prompts: prompts("password"),
      async authorize(inputs) {
        try {
          return await finishLogin(
            await site.login(accountFromInputs("password", inputs)),
            inputs?.keyId
          );
        } catch (error) {
          return failed(error);
        }
      }
    },
    ...["github", "linuxdo"].map(provider => ({
      type: "oauth",
      label: provider === "github" ? "使用 GitHub 登录 AnyRouter" : "使用 LinuxDO 登录 AnyRouter",
      prompts: prompts(provider),
      async authorize(inputs) {
        const account = accountFromInputs(provider, inputs);
        let used = false;
        return {
          url: account.siteURL + "/login",
          method: "code",
          instructions: `在 AnyRouter 登录页选择 ${provider === "github" ? "GitHub" : "LinuxDO"} 并完成正常登录。登录后打开浏览器 DevTools > Network，刷新账号页，把 /api/user/self 请求复制为 cURL 粘贴到这里。只导入 AnyRouter 会话和用户 ID，不会执行命令；也接受包含 cookie 和 userId 的 JSON 导出。`,
          async callback(value) {
            if (used) return failed(new Error("这份回传已被使用，请重新发起登录。"));
            used = true;
            try {
              return await finishLogin(await site.importSession(account, value), inputs?.keyId);
            } catch (error) {
              return failed(error);
            }
          }
        };
      }
    })),
    {
      type: "oauth",
      label: "AnyRouter 浏览器会话（WAF/JS 盾请用此入口；可签到）",
      prompts: prompts("session"),
      async authorize(inputs) {
        const account = accountFromInputs("session", inputs);
        let used = false;
        return {
          url: account.siteURL + "/login",
          method: "code",
          instructions: "在浏览器完成 AnyRouter 登录和 WAF/JS 盾验证。然后打开 DevTools > Network，刷新账号页，把 /api/user/self 请求复制为 cURL 粘贴到这里。导出应包含 session Cookie；如站点还要求 WAF 验证，请一并保留 acw_tc、cdn_sec_tc、acw_sc__v2。插件只解析文本，不执行命令。",
          async callback(value) {
            if (used) return failed(new Error("这份回传已被使用，请重新发起登录。"));
            used = true;
            try {
              return await finishLogin(await site.importSession(account, value), inputs?.keyId);
            } catch (error) {
              return failed(error);
            }
          }
        };
      }
    },
    {
      type: "api",
      keyless: true,
      label: "AnyRouter 系统访问令牌（无每日签到）",
      prompts: prompts("access-token"),
      async authorize(inputs) {
        try {
          return await finishLogin(
            await site.profile(accountFromInputs("access-token", inputs)),
            inputs?.keyId
          );
        } catch (error) {
          return failed(error);
        }
      }
    },
    {
      type: "api",
      label: "AnyRouter 模型 API key（仅推理）",
      placeholder: "模型 API key",
      prompts: prompts("api-key")
    }
  ];

  return {
    async config(cfg) {
      cfg.provider ??= {};
      explicit = structuredClone(cfg.provider[PROVIDER] ?? {});
      cfg.provider[PROVIDER] ??= {
        name: "AnyRouter",
        npm: "@ai-sdk/openai",
        api: SITES.top + "/v1",
        models: {}
      };
    },
    auth: {
      provider: PROVIDER,
      methods,
      icon: PLUGIN_ICON,
      options: [{
        key: "send-codex-headers",
        label: "默认兼容客户端请求头",
        description: "Responses 协议的模型请求自动使用 codex 客户端身份覆盖网关默认请求头；账号自定义请求头始终优先。",
        default: true
      }],
      async loader(getAuth, provider) {
        const state = readAccount(await getAuth(), provider);
        if (!state) return {};
        return {
          apiKey: state.key,
          async fetch(request, init = {}) {
            const account = readAccount(await getAuth(), provider);
            if (!account?.key) {
              throw new Error("This account has no model API key. Reconnect it before sending requests.");
            }
            if ((state.userId && account.userId && state.userId !== account.userId) ||
                state.apiBase !== account.apiBase ||
                ((!state.userId || !account.userId) && state.key !== account.key)) {
              throw Object.assign(
                new Error("The selected account changed during this request. Start a new request; no data was sent with the replacement account."),
                { code: "account_changed", status: 409, retryable: false }
              );
            }
            const incoming = new Headers(request instanceof Request ? request.headers : undefined);
            new Headers(init.headers).forEach((value, name) => incoming.set(name, value));
            const url = requestURL(request, init, incoming, account, provider, explicit);
            const headers = inferenceHeaders(account, incoming, protocolOfURL(request), compatibility());
            const target = request instanceof Request ? new Request(url, request) : url;
            return fetchImpl(target, { ...init, headers });
          }
        };
      },
      async usage(getAuth, provider) {
        const account = readAccount(await getAuth(), provider);
        if (!account) return { error: "未连接账号。", windows: [], signIn: "kept" };
        if (account.mode === "api-key") {
          return { plan: "API key - 仅推理", windows: [], signIn: "kept" };
        }
        try {
          const user = await site.self(account);
          const quota = quotaNumber(user.quota);
          if (quota === null) {
            return { error: "站点没有返回剩余余额。", windows: [], signIn: "kept" };
          }
          const balance = quota / quotaPerUnit;
          const display = "$" + balance.toFixed(Math.abs(balance) < 0.01 && balance !== 0 ? 6 : 2);
          return {
            balance: display,
            signIn: "kept",
            windows: [{ name: "AnyRouter 钱包", balance: Math.max(0, balance), unit: "USD", display }]
          };
        } catch (error) {
          return { error: error.message, windows: [], signIn: "kept" };
        }
      },
      async checkin(getAuth, provider) {
        const auth = await getAuth();
        const account = readAccount(auth, provider);
        if (!accountCapabilities(account).checkin) {
          return {
            outcome: "ineligible",
            message: "每日签到需要显式开启，并提供 AnyRouter 站点密码或有效会话。"
          };
        }

        const day = beijingDay(now());
        for (const [key, value] of completed) {
          if (value.day !== day) completed.delete(key);
        }
        const key = `${account.siteURL}:${account.userId}`;
        if (account.lastCheckinDay === day || completed.get(key)?.day === day) {
          return { outcome: "done", message: "该账号今日签到已完成。" };
        }
        if (pending.has(key)) {
          const result = await pending.get(key);
          return result.outcome === "claimed"
            ? { outcome: "done", message: "并发的每日签到已完成。" }
            : result;
        }

        const operation = (async () => {
          let siteAccount = account;
          let session = account.session;
          try {
            if (account.mode === "password") {
              const login = await site.login(account);
              siteAccount = login.account;
              session = login.account.session;
            } else {
              await site.self(account);
            }

            const signIn = await site.signIn(siteAccount);
            session = signIn.cookies || session;
            const daily = site.checkinResult(signIn);
            // A failed HTTP-200 response is retryable later; never burn the
            // Beijing day or persist it as a terminal check-in.
            if (daily.lastCheckin.outcome === "failed") {
              return daily.lastCheckin;
            }
            completed.set(key, { day: daily.lastCheckinDay });

            const latestAuth = await getAuth();
            const latest = readAccount(latestAuth, provider);
            if (latest?.userId !== account.userId || latest.siteURL !== account.siteURL) {
              return {
                ...daily.lastCheckin,
                message: "签到已完成，但所选账号已变更，未覆盖其凭据。"
              };
            }
            try {
              await input.client?.auth?.set?.({
                path: { id: PROVIDER },
                body: saveAccount({
                  ...latest,
                  session,
                  ...daily
                }, latestAuth)
              });
            } catch {
              return {
                ...daily.lastCheckin,
                message: "签到已完成，但刷新后的站点会话未能保存。"
              };
            }
            return daily.lastCheckin;
          } catch (error) {
            const result = checkinFailure(error);
            if (result.outcome !== "failed") {
              completed.set(key, { day });
              try {
                const latestAuth = await getAuth();
                const latest = readAccount(latestAuth, provider);
                if (latest?.userId === account.userId && latest.siteURL === account.siteURL) {
                  await input.client?.auth?.set?.({
                    path: { id: PROVIDER },
                    body: saveAccount({
                      ...latest,
                      session,
                      lastCheckinDay: day,
                      lastCheckin: result
                    }, latestAuth)
                  });
                }
              } catch {}
            }
            return result;
          }
        })();

        pending.set(key, operation);
        try {
          return await operation;
        } finally {
          pending.delete(key);
        }
      }
    },
    provider: {
      id: PROVIDER,
      models: (provider, { auth } = {}) => catalog(provider, readAccount(auth, provider))
    },
    "chat.headers": async (context, output) => {
      if (context.model?.providerID !== PROVIDER && context.provider?.info?.id !== PROVIDER) return;
      const supplied = new Headers(context.model?.headers);
      const modelId = context.model?.id || context.model?.api?.id;
      if (modelId) output.headers[MODEL_HINT_HEADER] = modelId;
      if (context.sessionID && !supplied.has("x-session-id") && !output.headers["x-session-id"]) {
        output.headers["x-session-id"] = context.sessionID;
      }
    }
  };
}
