export const MODEL_HINT_HEADER = "x-anyrouter-account-model";

const CODEX_UA = "codex_cli_rs/0.101.0";
const CODEX_UA_RE = /^codex_cli_rs\//i;

export const BROWSER_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "accept": "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "sec-ch-ua": "\"Chromium\";v=\"143\", \"Google Chrome\";v=\"143\", \"Not A(Brand\";v=\"24\"",
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": "\"macOS\"",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "priority": "u=1, i"
});

export function browserHeaders() {
  return new Headers(BROWSER_HEADERS);
}

const RESERVED = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "new-api-user",
  "x-api-key", "x-goog-api-key", "host", "content-length", "transfer-encoding", "connection", MODEL_HINT_HEADER
]);

export function customHeaders(value) {
  const result = new Headers();
  if (!value) return result;
  if (typeof value === "string") {
    for (const raw of value.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const at = line.indexOf(":");
      if (at < 1) throw new Error("自定义请求头必须每行一条 Name: value。");
      result.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  } else {
    new Headers(value).forEach((v, k) => result.set(k, v));
  }
  for (const name of result.keys()) {
    if (RESERVED.has(name)) throw new Error(`请求头 ${name} 由所选账号或传输层管理，不能自定义。`);
  }
  return result;
}

export function inferenceHeaders(account, incoming, protocol, compatibility = true) {
  // Model requests pass the gateway's native headers through; compatibility
  // only restores the codex client identity on Responses calls. Account
  // custom headers stay the final override for everything not managed here.
  const headers = new Headers(incoming);
  if (compatibility && protocol === "responses") {
    if (!CODEX_UA_RE.test(headers.get("user-agent") ?? "")) headers.set("user-agent", CODEX_UA);
    if (!headers.has("originator")) headers.set("originator", "codex_cli_rs");
  }
  customHeaders(account.headers).forEach((value, name) => headers.set(name, value));
  for (const name of ["authorization", "proxy-authorization", "cookie", "set-cookie", "new-api-user", "x-api-key", "x-goog-api-key", MODEL_HINT_HEADER]) {
    headers.delete(name);
  }
  if (protocol === "anthropic") headers.set("x-api-key", account.key);
  else if (protocol === "gemini") headers.set("x-goog-api-key", account.key);
  else headers.set("authorization", `Bearer ${account.key}`);
  return headers;
}
