export const PROVIDER = "anyrouter";

export const SITES = Object.freeze({
  top: "https://anyrouter.top"
});

export const API_ENDPOINTS = Object.freeze({
  top: "https://anyrouter.top",
  fcapp: "https://a-ocnfniawgw.cn-shanghai.fcapp.run"
});

const MODES = new Set([
  "api-key",
  "access-token",
  "password",
  "github",
  "linuxdo",
  "session",
  "legacy-session"
]);
const CHECKIN_MODES = new Set(["password", "github", "linuxdo", "session", "legacy-session"]);
const text = value => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const emailText = value => /^[^\s@]+@[^\s@]+$/.test(text(value)) ? text(value) : "";
const optedIn = value => value === true || value === "true" || value === "yes";

export function normalizeBase(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("端点必须是不含凭据、查询或片段的 http(s) 基础地址。");
  }
  return url.href.replace(/\/+$/, "");
}

export function siteChoice(value = "top") {
  if (!Object.hasOwn(SITES, value)) {
    throw new Error("只支持 AnyRouter 官方站点 anyrouter.top。");
  }
  return value;
}

export function apiEndpointChoice(value = "top") {
  if (!Object.hasOwn(API_ENDPOINTS, value)) {
    throw new Error("模型 API 端点只能选择 anyrouter.top 或 a-ocnfniawgw.cn-shanghai.fcapp.run。");
  }
  return value;
}

export function protocolBase(base, protocol = "responses") {
  const normalized = normalizeBase(base);
  const version = protocol === "gemini" ? "v1beta" : "v1";
  if (/\/(?:v1|v1beta)$/.test(normalized)) {
    return normalized.replace(/\/(?:v1|v1beta)$/, `/${version}`);
  }
  return normalized + "/" + version;
}

export function normalizeApiBase(value) {
  const normalized = normalizeBase(value);
  const url = new URL(normalized);
  const path = url.pathname.replace(/\/+$/, "");
  if (!Object.values(API_ENDPOINTS).includes(url.origin) || !["", "/", "/v1", "/v1beta"].includes(path)) {
    throw new Error("模型 API 端点只能是 anyrouter.top 或 a-ocnfniawgw.cn-shanghai.fcapp.run。");
  }
  return protocolBase(normalized);
}

function legacyValue(auth, key) {
  return auth?.[key] ?? auth?.metadata?.[key];
}

export function readAccount(auth, provider = {}) {
  if (!auth) return null;
  let saved;
  if (auth.type === "oauth") {
    try {
      saved = JSON.parse(auth.refresh);
    } catch {}
    if (saved?.provider !== PROVIDER || saved?.schema !== 2 || !MODES.has(saved.mode)) {
      throw new Error("无法识别的 AnyRouter 账号格式，请重新连接该账号。");
    }
  }

  const get = key => saved ? saved[key] : legacyValue(auth, key);
  const username = text(get("username"));
  const password = typeof get("password") === "string" ? get("password") : "";
  const session = text(get("session") || get("cookie"));
  const accessToken = text(get("accessToken"));
  const mode = saved?.mode ?? (username && password ? "password" : accessToken ? "access-token" : session ? "legacy-session" : "api-key");
  const site = siteChoice(text(get("site") || provider.site) || "top");
  const siteURL = normalizeBase(text(get("siteURL") || provider.siteURL) || SITES[site]);
  if (siteURL !== SITES.top) {
    throw new Error("AnyRouter 登录和站点接口只支持 anyrouter.top，请重新连接该账号。");
  }
  const legacyEndpoint = text(get("endpoint") || provider.endpoint);
  const explicitBase = text(get("apiBase"));
  const endpointChoice = text(get("apiEndpoint"));
  const apiBase = explicitBase || legacyEndpoint
    ? normalizeApiBase(explicitBase || legacyEndpoint)
    : endpointChoice ? protocolBase(API_ENDPOINTS[apiEndpointChoice(endpointChoice)]) : "";
  const userId = text(get("userId"));
  const email = emailText(get("email"));
  const checkinEnabled = CHECKIN_MODES.has(mode) && optedIn(get("checkinEnabled"));

  return {
    schema: 2,
    provider: PROVIDER,
    mode,
    site,
    siteURL,
    apiBase,
    key: text(saved ? auth.access : auth.key),
    keyId: text(get("keyId")),
    userId,
    username,
    email,
    label: text(get("label")) || (!saved && !email ? text(get("email")) : ""),
    session: mode === "api-key" ? "" : session,
    accessToken: mode === "api-key" ? "" : accessToken,
    headers: get("headers") ?? "",
    siteHeaders: get("siteHeaders") ?? "",
    checkinEnabled,
    password: mode === "password" && checkinEnabled ? password : "",
    lastCheckinDay: text(get("lastCheckinDay")),
    lastCheckin: get("lastCheckin") ?? null
  };
}

export function accountCapabilities(account) {
  const mode = account?.mode;
  const siteCredential = mode === "password"
    ? Boolean(account?.username && account?.password)
    : Boolean(account?.session);
  return {
    inference: Boolean(account?.key),
    usage: Boolean(account && mode !== "api-key" && account.userId && (account.session || account.accessToken)),
    checkin: Boolean(account?.checkinEnabled && CHECKIN_MODES.has(mode) && account.userId && siteCredential)
  };
}

export function saveAccount(account, previous = {}) {
  if (!MODES.has(account.mode) || !account.key) {
    throw new Error("已连接的账号必须有推理 key。");
  }
  if (account.mode !== "api-key" && !account.userId) {
    throw new Error("站点没有提供账号 ID。");
  }

  const { key, ...state } = account;
  state.schema = 2;
  state.provider = PROVIDER;
  state.checkinEnabled = CHECKIN_MODES.has(account.mode) && account.checkinEnabled === true;
  if (!state.checkinEnabled || account.mode !== "password") {
    delete state.password;
  }
  if (account.mode === "api-key") {
    delete state.session;
    delete state.accessToken;
    delete state.password;
  }

  return {
    type: "oauth",
    access: key,
    refresh: JSON.stringify(state),
    expires: 0,
    accountId: text(previous.accountId ?? previous.metadata?.email ?? previous.email) ||
      emailText(account.email) || text(account.username) || `AnyRouter ${text(account.userId)}`.trim(),
    ...(account.userId ? { uid: `${PROVIDER}:${account.userId}` } : {})
  };
}

export function withSiteIdentity(account, user) {
  const userId = assertSameUser(account, user);
  return {
    ...account,
    userId,
    username: text(user.username ?? account.username),
    email: emailText(user.email ?? account.email)
  };
}

export function assertSameUser(account, user) {
  const id = text(user?.id);
  if (!id || (account?.userId && id !== account.userId)) {
    throw new Error("站点返回的用户 ID 不一致或缺失，未替换账号凭据。");
  }
  return id;
}

export function beijingDay(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isKnownSite(value) {
  try {
    return Object.values(SITES).includes(new URL(value).origin);
  } catch {
    return false;
  }
}
