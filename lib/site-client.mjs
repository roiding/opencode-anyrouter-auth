import { SITES, assertSameUser, beijingDay, withSiteIdentity } from "./accounts.mjs";
import { browserHeaders, customHeaders } from "./headers.mjs";
import { createContext, runInContext } from "node:vm";

export class SiteError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = "SiteError";
    this.kind = kind;
    this.status = details.status ?? 0;
    this.retryAfterMs = details.retryAfterMs ?? 0;
    this.data = details.data ?? null;
  }
}

export function quotaNumber(value) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function mergeCookies(previous = "", responseHeaders) {
  const values = new Map();
  for (const pair of previous.split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) values.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  const separate = responseHeaders?.getSetCookie?.() ?? [];
  const lines = separate.length
    ? separate
    : (responseHeaders?.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=)/);
  for (const line of lines) {
    const pair = /^\s*([^=;,\s]+)=([^;]*)/.exec(line);
    if (!pair) continue;
    if (/;\s*max-age\s*=\s*0\s*(?:;|$)/i.test(line) || !pair[2]) values.delete(pair[1]);
    else values.set(pair[1], pair[2]);
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

function mergeCookieStrings(...sources) {
  const values = new Map();
  for (const source of sources) {
    for (const pair of String(source || "").split(";")) {
      const at = pair.indexOf("=");
      if (at > 0) values.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
}

function retryAfterMs(headers) {
  let result = 0;
  for (const name of ["retry-after-ms", "x-ms-retry-after-ms"]) {
    const raw = headers?.get?.(name);
    if (raw === null || raw === undefined) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) result = Math.max(result, value);
  }
  const retryAfter = headers?.get?.("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(value) && value >= 0) result = Math.max(result, value);
  }
  return result;
}

function isShieldChallenge(response, raw) {
  const contentType = response?.headers?.get?.("content-type") || "";
  const text = String(raw || "");
  if (/text\/html/i.test(contentType) &&
      /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|challenge-platform|<script/i.test(text)) {
    return true;
  }
  return /var\s+arg1\s*=/.test(text);
}

const CHALLENGE_SCRIPT_LIMIT = 128 * 1024;

export function solveWafChallenge(raw) {
  const html = String(raw || "");
  if (!html || html.length > CHALLENGE_SCRIPT_LIMIT * 2) return "";
  const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]);
  for (const script of scripts) {
    if (script.length > CHALLENGE_SCRIPT_LIMIT ||
        !/\barg1\s*=/.test(script) || !/acw_sc__v2/.test(script)) continue;
    let cookie = "";
    const document = {
      get cookie() {
        return cookie;
      },
      set cookie(value) {
        const match = /(?:^|;\s*)acw_sc__v2=([^;]+)/i.exec(String(value));
        if (match && /^[A-Za-z0-9._~-]{1,512}$/.test(match[1])) {
          cookie = `acw_sc__v2=${match[1]}`;
        }
      },
      location: { reload() {} },
      body: { appendChild() {} },
      createElement() {
        return { style: {}, appendChild() {}, setAttribute() {}, remove() {} };
      }
    };
    const window = {
      document,
      location: document.location,
      navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36" }
    };
    const context = createContext({
      document,
      window,
      self: window,
      top: window,
      parent: window,
      location: document.location,
      navigator: window.navigator,
      setTimeout() { return 0; },
      clearTimeout() {},
      console: { log() {}, warn() {}, error() {} }
    });
    try {
      runInContext(script, context, { timeout: 1000 });
    } catch {
      continue;
    }
    if (cookie) return cookie;
  }
  return "";
}

const CAPTCHA_RE = /captcha|turnstile|验证码|人机验证|challenge-platform|cf-chl|aliyun_waf_aa/i;
const FORBIDDEN_RE = /无权|权限不足|禁止|封禁|banned|forbidden|permission denied|access denied/i;
const RATE_RE = /请求次数过多|请求过多|限流|稍后再试|too many requests|rate.?limit|负载已饱和|负载已满|系统繁忙|繁忙|overloaded|server busy/i;
const INACTIVE_RE = /未开启签到|签到.*未开启|签到.*关闭|没有签到|不支持.*签到|签到.*不支持|活动.*未开启|活动.*结束|not support.*checkin|checkin.*not supported|inactive/i;
const ALREADY_RE = /已签到|已经签到|今日已|今天已|重复签到|已领取|already (?:signed|checked)|checked.?in today|no.?reward/i;
const CREDENTIAL_RE = /密码错误|用户名或密码|账号或密码|incorrect password|wrong password|未登录|登录已过期|登录失效|invalid (?:password|credential|token)|unauthorized|not logged/i;
const SITE_HEADER_NAMES = new Set([
  "cookie", "new-api-user", "user-agent", "accept-language", "accept", "x-requested-with",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-dest", "sec-fetch-mode",
  "sec-fetch-site", "priority"
]);

export function classifySiteMessage(message, status = 0) {
  const value = String(message || "");
  if (ALREADY_RE.test(value)) return "done";
  if (CAPTCHA_RE.test(value)) return "captcha";
  if (INACTIVE_RE.test(value)) return "inactive";
  if (FORBIDDEN_RE.test(value) || status === 403) return "ineligible";
  if (status === 401 || CREDENTIAL_RE.test(value)) return "ineligible";
  if (status === 404 || status === 405) return "inactive";
  if (status === 429 || RATE_RE.test(value)) return "failed";
  return null;
}

function siteFailure(response, data, raw, operation) {
  const status = response?.status ?? 0;
  const message = String(data?.message ?? data?.error?.message ?? data?.msg ?? "").trim();
  const combined = `${message} ${String(raw || "").slice(0, 4000)}`;
  const details = { status, retryAfterMs: retryAfterMs(response?.headers), data };

  if (isShieldChallenge(response, raw)) {
    return new SiteError("waf", "AnyRouter 返回了 WAF/JS 盾验证页，自动挑战未完成。请改用“AnyRouter 浏览器会话（WAF/JS 盾请用此入口；可签到）”入口，在浏览器完成验证后导入 /api/user/self。", details);
  }
  if (CAPTCHA_RE.test(combined)) {
    return new SiteError("captcha", "站点要求 Turnstile/验证码，插件不会代解；请在浏览器完成后重试。", details);
  }
  if (ALREADY_RE.test(message)) {
    return new SiteError("already", message || "今天已经签到。", details);
  }
  if (INACTIVE_RE.test(message) || status === 404 || status === 405) {
    return new SiteError("inactive", message || "站点当前没有可用的签到接口。", details);
  }
  if (status === 401 || CREDENTIAL_RE.test(message) || (status === 403 && !FORBIDDEN_RE.test(message))) {
    return new SiteError("credentials", `站点拒绝了 ${operation}；请重新连接该账号。`, details);
  }
  if (status === 403 || FORBIDDEN_RE.test(message)) {
    return new SiteError("forbidden", message || "账号没有执行该站点操作的权限。", details);
  }
  if (status === 429 || RATE_RE.test(message)) {
    return new SiteError("rate-limit", message || "站点对该操作限流，请稍后再试。", details);
  }
  if (status >= 500) {
    return new SiteError("unavailable", `站点暂时不可用（HTTP ${status}），请稍后再试。`, details);
  }
  if (status === 0) {
    return new SiteError("unavailable", "站点请求失败或超时。", details);
  }
  if (message) {
    return new SiteError("unavailable", message, details);
  }
  return new SiteError("unavailable", `站点未能完成 ${operation}（HTTP ${status}）。`, details);
}

export async function readBoundedText(response, limit = 2 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new SiteError("unavailable", "站点响应超过了账号 API 的大小上限。");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function safeSiteHeaders(value) {
  if (!value) return {};
  const result = {};
  let headers;
  try {
    headers = new Headers(value);
  } catch {
    return result;
  }
  for (const name of SITE_HEADER_NAMES) {
    if (name === "cookie" || name === "new-api-user") continue;
    if (headers.has(name)) result[name] = headers.get(name);
  }
  return result;
}

export function parseSessionHandoff(value, { allowedOrigins = Object.values(SITES) } = {}) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 65536) {
    throw new SiteError("credentials", "粘贴有边界的 AnyRouter 会话导出，或 Copy as cURL 请求文本。");
  }

  let cookie;
  let userId;
  let siteHeaders = {};
  if (text.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new SiteError("credentials", "会话导出不是合法的 JSON。");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new SiteError("credentials", "会话导出必须是一个对象。");
    }
    cookie = data.cookie ?? data.cookies;
    userId = String(data.userId ?? data.user_id ?? "");
    siteHeaders = safeSiteHeaders(data.siteHeaders ?? data.headers);
  } else {
    // Clipboard text is data, never a command. Only a site self request and
    // the minimum browser headers are accepted. DevTools emits both
    // `curl '<url>'` and `curl --url '<url>'` shapes; the origin, path and
    // credential checks below stay strict either way.
    if (!/^curl(?:\.exe)?\b/.test(text)) {
      throw new SiteError("credentials", "请粘贴浏览器 DevTools 复制的 cURL 命令文本。");
    }
    const target = /(['"])(https:\/\/[^'"\s]+)\1/.exec(text);
    let url;
    try {
      url = new URL(target?.[2]);
    } catch {}
    if (!url || !allowedOrigins.includes(url.origin) || url.pathname !== "/api/user/self" || url.username || url.password) {
      throw new SiteError("credentials", "请复制 AnyRouter 的 /api/user/self 请求，而不是 GitHub 或 LinuxDO 的请求。");
    }
    const headers = new Headers();
    for (const match of text.matchAll(/(?:^|\s)(?:-H|--header)\s+(?:'([^'\r\n]*)'|"([^"\r\n]*)")/g)) {
      const value = match[1] ?? match[2];
      const at = value.indexOf(":");
      if (at <= 0) continue;
      const name = value.slice(0, at).trim().toLowerCase();
      if (SITE_HEADER_NAMES.has(name)) {
        try {
          headers.set(name, value.slice(at + 1).trim());
        } catch {
          throw new SiteError("credentials", "导出的站点请求头无效。");
        }
      }
    }
    const cookies = /(?:^|\s)(?:-b|--cookie)\s+(['"])([^'"\r\n]*)\1/.exec(text);
    cookie = headers.get("cookie") || cookies?.[2];
    userId = headers.get("new-api-user") || "";
    for (const name of SITE_HEADER_NAMES) {
      if (name === "cookie" || name === "new-api-user") continue;
      if (headers.has(name)) siteHeaders[name] = headers.get(name);
    }
  }

  if (typeof cookie !== "string" || !/(?:^|;\s*)session=[^;\s]+/.test(cookie) || /[\r\n]/.test(cookie) ||
      !/^\d+$/.test(userId)) {
    throw new SiteError("credentials", "导出必须包含 AnyRouter 的 session Cookie、可选 WAF Cookie，以及数字形式的 New-Api-User ID。");
  }
  return { session: cookie, userId, siteHeaders };
}

export function createSiteClient({ fetchImpl = (...args) => fetch(...args), timeoutMs = 30000, now = Date.now } = {}) {
  async function requestRaw(account, path, options = {}) {
    const {
      body,
      anonymous = false,
      cookies = "",
      signal,
      operation = "account read",
      navigation = false,
      allowChallenge = true
    } = options;
    if (account.siteURL !== SITES.top) {
      throw new SiteError("credentials", "AnyRouter 登录和站点接口只支持 anyrouter.top。");
    }
    const headers = browserHeaders();
    headers.set("referer", account.siteURL + (navigation ? "/login" : path === "/api/pricing" ? "/pricing" : "/"));
    if (navigation) {
      headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8");
      headers.set("cache-control", "max-age=0");
      headers.set("sec-fetch-dest", "document");
      headers.set("sec-fetch-mode", "navigate");
      headers.set("sec-fetch-site", "none");
      headers.set("upgrade-insecure-requests", "1");
      headers.delete("priority");
    } else {
      headers.set("cache-control", "no-store");
    }
    if (body !== undefined) headers.set("origin", account.siteURL);
    if (operation === "daily sign-in") headers.set("x-requested-with", "XMLHttpRequest");
    customHeaders(account.headers).forEach((value, name) => headers.set(name, value));
    customHeaders(account.siteHeaders).forEach((value, name) => headers.set(name, value));

    const cookie = cookies || (anonymous ? "" : account.session);
    if (cookie) headers.set("cookie", cookie);
    if (!anonymous) {
      if (account.accessToken) headers.set("authorization", account.accessToken);
      if (account.userId) headers.set("new-api-user", account.userId);
    } else {
      headers.set("new-api-user", "-1");
    }
    if (body !== undefined) headers.set("content-type", "application/json");

    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
    const response = await fetchImpl(account.siteURL + path, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal
      });
      const raw = await readBoundedText(response);
      let data;
      try {
        data = JSON.parse(raw);
      } catch {}
      const result = {
        response,
        raw,
        data,
        cookies: mergeCookies(cookie, response.headers),
        status: response.status
      };
      if (allowChallenge && isShieldChallenge(response, raw)) {
        const challengeCookie = solveWafChallenge(raw);
        if (challengeCookie) {
          return requestRaw(account, path, {
            ...options,
            cookies: mergeCookieStrings(cookie, result.cookies, challengeCookie),
            allowChallenge: false
          });
        }
      }
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof SiteError) throw error;
      throw new SiteError("unavailable", "站点请求失败或超时；未执行自动重试登录。");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function request(account, path, options = {}) {
    const result = await requestRaw(account, path, options);
    if (!result.response.ok || !result.data || result.data.success !== true) {
      throw siteFailure(result.response, result.data, result.raw, options.operation || "account read");
    }
    return { data: result.data.data, cookies: result.cookies, raw: result.raw, response: result.response };
  }

  async function status(account, signal, cookies = account.session) {
    return request(account, "/api/status", {
      anonymous: true,
      cookies,
      signal,
      operation: "site status read"
    });
  }

  async function bootstrapLoginPage(account, signal) {
    return requestRaw(account, "/login", {
      anonymous: true,
      cookies: account.session,
      signal,
      navigation: true,
      operation: "login page bootstrap"
    });
  }

  async function login(account, signal) {
    if (!account.username || !account.password) {
      throw new SiteError("credentials", "需要提供 AnyRouter 站点用户名和密码。");
    }
    let bootstrap;
    let siteStatus;
    try {
      siteStatus = await status(account, signal);
    } catch (error) {
      if (error?.kind !== "waf") throw error;
      bootstrap = await bootstrapLoginPage(account, signal);
      siteStatus = await status(account, signal, bootstrap.cookies);
    }
    if (siteStatus.data?.turnstile_check === true) {
      throw new SiteError("captcha", "AnyRouter 当前开启了 Turnstile；请在浏览器登录后导入站点会话。");
    }
    const loginOptions = cookies => ({
      anonymous: true,
      cookies,
      body: { username: account.username, password: account.password },
      signal,
      operation: "password login"
    });
    let result;
    try {
      result = await request(
        account,
        "/api/user/login?turnstile=",
        loginOptions(mergeCookieStrings(account.session, siteStatus.cookies))
      );
    } catch (error) {
      if (error?.kind !== "waf") throw error;
      bootstrap ??= await bootstrapLoginPage(account, signal);
      result = await request(
        account,
        "/api/user/login?turnstile=",
        loginOptions(mergeCookieStrings(account.session, bootstrap.cookies, siteStatus.cookies))
      );
    }
    if (!result.data || typeof result.data !== "object") {
      throw new SiteError("unavailable", "站点登录响应缺少用户信息。");
    }
    return {
      user: result.data,
      status: siteStatus.data,
      account: withSiteIdentity({ ...account, session: result.cookies }, result.data)
    };
  }

  async function selfResponse(account) {
    if (!account.userId || (!account.session && !account.accessToken)) {
      throw new SiteError("credentials", "读取账号信息需要站点会话或系统访问令牌加用户 ID。");
    }
    const result = await request(account, "/api/user/self", { operation: "account read" });
    assertSameUser(account, result.data);
    return result;
  }

  async function self(account) {
    return (await selfResponse(account)).data;
  }

  async function profile(account) {
    const result = await selfResponse(account);
    return {
      user: result.data,
      account: withSiteIdentity({ ...account, session: result.cookies }, result.data),
      profileVerified: true
    };
  }

  async function importSession(account, text) {
    // Session handoff is deliberately limited to the confirmed AnyRouter
    // origin. A legacy/custom siteURL must not turn clipboard text into an
    // arbitrary cookie import target.
    if (!Object.values(SITES).includes(new URL(account.siteURL).origin)) {
      throw new SiteError("credentials", "会话导入只支持已知的 AnyRouter 站点。");
    }
    const handoff = parseSessionHandoff(text, { allowedOrigins: Object.values(SITES) });
    if (account.userId && account.userId !== handoff.userId) {
      throw new SiteError("credentials", "导出的会话属于另一个账号。");
    }
    const candidate = { ...account, ...handoff, accessToken: "", password: "" };
    return profile(candidate);
  }

  async function selectKey(account, selection = "") {
    const selected = String(selection).trim();
    if (selected && !/^\d+$/.test(selected)) {
      throw new SiteError("selection", "请指定一个现有 API key 的数字 ID。");
    }
    const result = await request(account, selected ? `/api/token/${selected}` : "/api/token/?p=0&size=100", {
      operation: "API key lookup"
    });
    const items = selected ? [result.data] : Array.isArray(result.data) ? result.data : result.data?.items;
    if (!Array.isArray(items)) {
      throw new SiteError("unavailable", "站点没有返回 API key 列表。");
    }
    const active = items.filter(item => {
      const expires = quotaNumber(item?.expired_time);
      const remaining = quotaNumber(item?.remain_quota);
      return item?.status === 1 && typeof item.key === "string" && item.key.trim() && !/[\s*]/.test(item.key) &&
        (expires === null || expires <= 0 || expires * 1000 > now()) &&
        (item.unlimited_quota === true || remaining === null || remaining > 0);
    });
    if (selected && active[0] && String(active[0].id) !== selected) {
      throw new SiteError("selection", "站点返回了不同的 API key ID。");
    }
    const truncated = !selected && Number(result.data?.total) > items.length;
    if (!active.length) {
      throw new SiteError("selection", "没有可用的 API key。请先在网站上创建或启用一个 key，再重新连接。");
    }
    if (active.length !== 1 || truncated) {
      const ids = active.slice(0, 10).map(item => String(item.id)).filter(id => /^\d+$/.test(id)).join(", ");
      throw new SiteError("selection", `More than one key may be available. Select an existing key ID in advanced login settings${ids ? ` (IDs: ${ids})` : ""}.`);
    }
    return { key: active[0].key.trim(), keyId: String(active[0].id ?? "") };
  }

  async function signIn(account, signal) {
    if (!account.session) {
      throw new SiteError("credentials", "AnyRouter 签到需要有效的站点会话 Cookie。");
    }
    const result = await requestRaw({ ...account, accessToken: "" }, "/api/user/sign_in", {
      body: {},
      signal,
      operation: "daily sign-in"
    });
    if (!result.response.ok) {
      throw siteFailure(result.response, result.data, result.raw, "daily sign-in");
    }
    if (!result.data || typeof result.data !== "object") {
      throw siteFailure(result.response, result.data, result.raw, "daily sign-in");
    }
    return {
      success: result.data.success === true,
      message: String(result.data.message ?? "").trim(),
      data: result.data.data,
      cookies: result.cookies,
      status: result.status
    };
  }

  function checkinResult(result) {
    const message = result.message || "";
    const outcome = result.success
      ? (ALREADY_RE.test(message) ? "done" : "claimed")
      : (classifySiteMessage(message) || "failed");
    const lastCheckin = {
      outcome,
      message: message || (outcome === "claimed" ? "AnyRouter 签到请求成功。" : "AnyRouter 未返回签到结果。")
    };
    const reward = quotaNumber(result.data?.reward ?? result.data?.credit);
    if (Number.isFinite(reward) && reward > 0) lastCheckin.credit = reward;
    return { lastCheckinDay: beijingDay(now()), lastCheckin };
  }

  return {
    request,
    requestRaw,
    status,
    login,
    self,
    profile,
    importSession,
    selectKey,
    signIn,
    checkinResult
  };
}

export const _internal = { classifySiteMessage, isShieldChallenge, retryAfterMs, siteFailure, solveWafChallenge };
