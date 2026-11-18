import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import entry from "../index.mjs";

const decoder = new TextDecoder();
const encrypted = { type: "invalid_request_error", code: "invalid_encrypted_content", message: "The encrypted content could not be verified." };
const history = {
  model: "model-chosen-by-the-request", stream: true, store: true,
  include: ["reasoning.encrypted_content"], reasoning: { effort: "high" },
  input: [
    { type: "reasoning", id: "old-reasoning", encrypted_content: "private-reasoning" },
    { type: "message", id: "old-message", role: "user", content: "private-message" }
  ]
};
const auth = {
  type: "api", key: "sk-private-test-key",
  metadata: {
    endpoint: "https://a-ocnfniawgw.cn-shanghai.fcapp.run", site: "top", username: "test-user",
    password: "private-site-password", accessToken: "private-site-token",
    cookie: "session=private-session", userId: "123", headers: "X-Account: custom"
  }
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" }
});
const frame = (event, value = {}) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const completed = frame("response.completed", { response: { output: [{ type: "reasoning", encrypted_content: "new-good" }] } });
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const textBody = init => typeof init.body === "string" ? init.body : decoder.decode(init.body);

async function mockedFetch(fn, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(); }
  finally { globalThis.fetch = previous; }
}

test("combined entry preserves provider identity and existing providers, with six independent login methods", async () => {
  const hooks = await entry.server({ client: {} }, { filter: { enabled: true } });
  const openai = { name: "User OpenAI", models: { userModel: {} } };
  const anthropic = { name: "User Anthropic", headers: { "x-user": "kept" } };
  const config = { provider: { openai, anthropic } };
  await hooks.config(config);
  assert.equal(config.provider.openai, openai);
  assert.equal(config.provider.anthropic, anthropic);
  assert.deepEqual(Object.keys(config.provider).sort(), ["anthropic", "anyrouter", "openai"]);
  assert.equal(hooks.auth.provider, "anyrouter");
  assert.equal(hooks.provider.id, "anyrouter");
  assert.deepEqual(hooks.auth.methods.map(method => method.type), ["api", "oauth", "oauth", "oauth", "api", "api"]);
  assert.deepEqual(config.provider.anyrouter.models, {});
  assert.deepEqual(hooks.auth.options.map(option => option.key), ["send-codex-headers", "conditional-history-filter"]);
  assert.equal(typeof hooks.auth.usage, "function");
  assert.equal(typeof hooks.auth.checkin, "function");
});

test("combined loader keeps account/header/session auth and filters only the model request", async () => {
  const calls = [], logs = [];
  const raw = "\n " + JSON.stringify(history, null, 2) + "\n";
  await mockedFetch(async (url, init) => {
    const text = textBody(init);
    calls.push({ url, init, body: JSON.parse(text), raw: text });
    return calls.length === 1 ? sse(
      frame("response.output_item.done", { item: { type: "custom_tool_call", call_id: "failed-tool" } })
      + frame("response.failed", { response: { error: encrypted } })
    ) : sse(completed);
  }, async () => {
    const hooks = await entry.server({ client: { app: { log: value => { logs.push(value); return Promise.resolve(); } } } });
    const loaded = await hooks.auth.loader(async () => auth, { models: {} });
    assert.equal(loaded.baseURL, undefined, "do not override per-model API URLs");
    assert.equal(loaded.apiKey, auth.key);
    const headers = {};
    await hooks["chat.headers"]({ model: { providerID: "anyrouter" }, sessionID: "same-session" }, { headers });
    const request = new Request("https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/responses", {
      method: "POST", body: raw, headers: { "x-request": "kept", "x-session-id": headers["x-session-id"] }
    });
    const response = await loaded.fetch(request, { headers: { "x-extra": "also-kept" } });
    const text = await response.text();
    assert.match(text, /new-good/);
    assert.doesNotMatch(text, /failed-tool|response.failed/);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].raw, raw);
  assert.deepEqual(calls[0].body, history);
  assert.equal(calls[1].body.store, false);
  assert.deepEqual(calls[1].body.include, []);
  assert.deepEqual(calls[1].body.input, [{ type: "message", role: "user", content: "private-message" }]);
  for (const call of calls) {
    assert.equal(call.url, "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/responses");
    assert.equal(call.body.model, history.model);
    assert.equal(call.init.headers.get("authorization"), `Bearer ${auth.key}`);
    assert.equal(call.init.headers.get("user-agent"), "codex_cli_rs/0.101.0");
    assert.equal(call.init.headers.get("originator"), "codex_cli_rs");
    assert.equal(call.init.headers.get("x-account"), "custom");
    assert.equal(call.init.headers.get("x-request"), "kept");
    assert.equal(call.init.headers.get("x-extra"), "also-kept");
    assert.equal(call.init.headers.get("x-session-id"), "same-session");
  }
  assert.equal(logs.filter(row => row.body.message === "history-cleanup").length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /sk-private-test-key|private-site-password|private-site-token|private-session|private-message|private-reasoning/);
});

test("model discovery still uses upstream catalog and never applies response-history retry", async () => {
  const calls = [];
  await mockedFetch(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/api/pricing")) return json({ success: true, data: [
      { model_name: "account-model-a", limit: { input: 115000, output: 8000 }, tool_call: false,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
      { model_name: "public-only", limit: { context: 999999 } }
    ] });
    return json({ data: [{ id: "account-model-a", context_length: 123456, supported_endpoint_types: ["openai"] }, { id: "account-model-b", supported_endpoint_types: ["anthropic"] }] });
  }, async () => {
    const hooks = await entry.server({}, { modelsRegistryPath: fileURLToPath(new URL("./fixtures/models.json", import.meta.url)) });
    const models = await hooks.provider.models({ models: {} }, { auth });
    assert.deepEqual(Object.keys(models), ["account-model-a", "account-model-b"]);
    assert.equal(models["account-model-a"].limit.context, 123456);
    assert.equal(models["account-model-a"].limit.input, 115000);
    assert.deepEqual(Object.keys(models["account-model-a"].variants), ["low", "high"]);
    assert.equal(models["account-model-a"].capabilities.toolcall, false);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/models");
  assert.equal(calls[0].init.headers.get("authorization"), `Bearer ${auth.key}`);
  assert.equal(calls[1].url, "https://anyrouter.top/api/pricing");
  for (const name of ["authorization", "cookie"]) assert.equal(calls[1].init.headers.get(name), null);
  assert.equal(calls[1].init.headers.get("new-api-user"), "-1");
});

test("opted-in check-in uses a separate sign_in call and never filters or retries", async t => {
  const optedIn = { ...auth, metadata: { ...auth.metadata, checkinEnabled: true } };
  for (const [name, record, response, outcome, expectedCalls] of [
    ["claimed", optedIn, () => json({ success: true, message: "签到成功" }), "claimed", 3],
    ["done", optedIn, () => json({ success: false, message: "今天已经签到" }), "done", 3],
    ["legacy password is not consent", auth, () => json({}), "ineligible", 0],
    ["missing site password", { type: "api", key: auth.key }, () => json({}), "ineligible", 0],
    ["bad site password", optedIn, () => json({ success: false, message: "incorrect password" }), "ineligible", 2],
    ["captcha", optedIn, () => new Response("<!doctype html><html>captcha</html>"), "captcha", 1],
    ["site unavailable", optedIn, () => { throw new Error("unreachable"); }, "failed", 1]
  ]) await t.test(name, async () => {
    const calls = [], logs = [];
    await mockedFetch(async (url, init) => {
      calls.push({ url, init });
      if (name === "site unavailable") throw new Error("unreachable");
      if (name === "captcha" && url.endsWith("/api/status")) return response();
      if (url.endsWith("/api/status")) return json({ success: true, data: { turnstile_check: false } });
      if (url.includes("/api/user/login")) {
        if (name === "bad site password") return response();
        return new Response(JSON.stringify({ success: true, data: { id: 123, username: "test-user" } }), {
          headers: { "content-type": "application/json", "set-cookie": "session=fresh" }
        });
      }
      return response();
    }, async () => {
      const hooks = await entry.server({ client: { app: { log: row => logs.push(row) } } });
      const result = await hooks.auth.checkin(async () => record, { models: {} });
      assert.equal(result.outcome, outcome);
      assert.equal(result.signIn, undefined);
    });
    assert.equal(calls.length, expectedCalls);
    if (calls.length) assert.equal(calls[0].url, "https://anyrouter.top/api/status");
    if (calls.length > 1) assert.equal(calls[1].url, "https://anyrouter.top/api/user/login?turnstile=");
    if (calls.length > 2) assert.equal(calls[2].url, "https://anyrouter.top/api/user/sign_in");
    assert.deepEqual(logs, []);
  });
});

test("WAF-blocked balances stay unknown without login or consumption fallback", async () => {
  const responses = [new Response("<!doctype html><html>captcha</html>")];
  const calls = [], logs = [];
  await mockedFetch(async (url, init) => { calls.push({ url, init }); return responses.shift(); }, async () => {
    const hooks = await entry.server({ client: { app: { log: row => logs.push(row) } } });
    const record = { ...auth, metadata: { ...auth.metadata, username: "", password: "" } };
    const usage = await hooks.auth.usage(async () => record, {});
    assert.equal(usage.balance, undefined);
    assert.deepEqual(usage.windows, []);
    assert.match(usage.error, /WAF|验证/);
  });
  assert.deepEqual(calls.map(call => call.url), ["https://anyrouter.top/api/user/self"]);
  assert.deepEqual(logs, []);
});

test("second-argument filter setting and provider switch both bypass the filter", async t => {
  for (const [name, input, options] of [
    ["plugin JSON options", {}, { filter: { enabled: false } }],
    ["provider switch", { magpie: { option: (provider, key) => key === "conditional-history-filter" ? false : true } }, {}]
  ]) await t.test(name, async () => {
    const calls = [];
    await mockedFetch(async (url, init) => { calls.push({ url, init }); return json({ error: encrypted }, 400); }, async () => {
      const hooks = await entry.server(input, options);
      const loaded = await hooks.auth.loader(async () => auth, { models: {} });
      const response = await loaded.fetch("https://anyrouter.top/v1/responses", { method: "POST", body: JSON.stringify(history) });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: encrypted });
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(textBody(calls[0].init)), history);
  });
});

test("concurrent accounts keep credentials and cleanup state isolated", async () => {
  const counts = new Map(), calls = [];
  await mockedFetch(async (url, init) => {
    const key = init.headers.get("authorization");
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    calls.push({ key, url, body: JSON.parse(textBody(init)) });
    return key === "Bearer account-a" && count === 1 ? json({ error: encrypted }, 400) : sse(completed);
  }, async () => {
    const hooks = await entry.server();
    const endpoint = key => key === "account-a"
      ? "https://anyrouter.top"
      : "https://a-ocnfniawgw.cn-shanghai.fcapp.run";
    const account = key => ({ ...auth, key, metadata: { ...auth.metadata, endpoint: endpoint(key) } });
    const a = await hooks.auth.loader(async () => account("account-a"), { models: {} });
    const b = await hooks.auth.loader(async () => account("account-b"), { models: {} });
    const send = async (loaded, key) => (await loaded.fetch(`${endpoint(key)}/v1/responses`, { method: "POST", body: JSON.stringify(history) })).text();
    await Promise.all([send(a, "account-a"), send(b, "account-b")]);
  });
  const a = calls.filter(call => call.key === "Bearer account-a");
  const b = calls.filter(call => call.key === "Bearer account-b");
  assert.equal(a.length, 2);
  assert.equal(b.length, 1);
  assert.deepEqual(a[0].body, history);
  assert.equal(a[1].body.store, false);
  assert.deepEqual(b[0].body, history);
  assert.ok(a.every(call => call.url === "https://anyrouter.top/v1/responses"));
  assert.equal(b[0].url, "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/responses");
});

test("invalid filter options fail visibly at the actual host entry", async () => {
  await assert.rejects(entry.server({}, { filter: { enabled: "yes" } }), /filter.enabled/);
  await assert.rejects(entry.server({}, { filter: { deadlineMs: -1 } }), /filter.deadlineMs/);
});
