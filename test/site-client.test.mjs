import assert from "node:assert/strict";
import test from "node:test";
import {
  createSiteClient,
  mergeCookies,
  parseSessionHandoff,
  quotaNumber,
  solveWafChallenge
} from "../lib/site-client.mjs";
import { customHeaders, inferenceHeaders } from "../lib/headers.mjs";
import { SITES } from "../lib/accounts.mjs";

const json = (data, headers = {}) => new Response(JSON.stringify({ success: true, data }), {
  headers: { "content-type": "application/json", ...headers }
});
const rawJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers }
});
const account = extra => ({
  mode: "password",
  site: "top",
  siteURL: "https://anyrouter.top",
  userId: "",
  username: "alice",
  password: "private-password",
  key: "private-model-key",
  session: "",
  accessToken: "",
  headers: "",
  siteHeaders: "",
  checkinEnabled: false,
  ...extra
});
const status = (extra = {}, headers = {}) => json({
  turnstile_check: false,
  quota_per_unit: 500000,
  ...extra
}, headers);
const waf = () => new Response('<html><script>var arg1 = "challenge"</script></html>', {
  headers: { "content-type": "text/html" }
});
const key = { id: 7, status: 1, key: "existing-model-key", expired_time: -1, unlimited_quota: true };

function harness(steps, options = {}) {
  const calls = [];
  const client = createSiteClient({
    ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = steps.shift();
      assert.ok(next, "Unexpected additional site request: " + new URL(url).pathname);
      return typeof next === "function" ? next(url, init) : next;
    }
  });
  return { client, calls };
}

test("password login reads status first, carries WAF cookies and sends no model authorization", async () => {
  const h = harness([
    status({}, { "set-cookie": "acw_tc=waf-pass; Path=/" }),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=site-session; HttpOnly; Path=/" })
  ]);
  const result = await h.client.login(account());
  assert.equal(result.account.userId, "123");
  assert.equal(result.account.session, "acw_tc=waf-pass; session=site-session");
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), ["/api/status", "/api/user/login"]);
  const login = h.calls[1];
  assert.equal(new URL(login.url).searchParams.get("turnstile"), "");
  assert.equal(login.init.redirect, "error");
  assert.equal(login.init.headers.has("authorization"), false);
  assert.equal(login.init.headers.get("cookie"), "acw_tc=waf-pass");
  assert.equal(login.init.headers.get("new-api-user"), "-1");
  assert.deepEqual(JSON.parse(login.init.body), { username: "alice", password: "private-password" });
});

test("WAF on the first site request bootstraps /login and retries with anonymous cookies", async () => {
  const h = harness([
    waf(),
    new Response("<html>login page</html>", {
      headers: { "content-type": "text/html", "set-cookie": "_c_WBKFRo=anonymous; Path=/; HttpOnly" }
    }),
    status({}, { "set-cookie": "acw_tc=waf-pass; Path=/" }),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=site-session; HttpOnly; Path=/" })
  ]);
  const result = await h.client.login(account());
  assert.equal(result.account.userId, "123");
  assert.match(result.account.session, /_c_WBKFRo=anonymous/);
  assert.match(result.account.session, /acw_tc=waf-pass/);
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), [
    "/api/status",
    "/login",
    "/api/status",
    "/api/user/login"
  ]);
  const bootstrap = h.calls[1];
  assert.equal(bootstrap.init.method, "GET");
  assert.equal(bootstrap.init.headers.get("sec-fetch-mode"), "navigate");
  assert.equal(bootstrap.init.headers.get("new-api-user"), "-1");
  const login = h.calls[3];
  assert.match(login.init.headers.get("cookie"), /_c_WBKFRo=anonymous/);
  assert.match(login.init.headers.get("cookie"), /acw_tc=waf-pass/);
  assert.equal(login.init.headers.get("new-api-user"), "-1");
});

test("WAF on password login bootstraps the login page and retries once", async () => {
  const h = harness([
    status(),
    waf(),
    new Response("<html>login page</html>", {
      headers: { "content-type": "text/html", "set-cookie": "_c_WBKFRo=anonymous; Path=/; HttpOnly" }
    }),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=site-session; HttpOnly; Path=/" })
  ]);
  const result = await h.client.login(account());
  assert.equal(result.account.userId, "123");
  assert.match(result.account.session, /_c_WBKFRo=anonymous/);
  assert.match(result.account.session, /session=site-session/);
  assert.deepEqual(h.calls.map(call => new URL(call.url).pathname), [
    "/api/status",
    "/api/user/login",
    "/login",
    "/api/user/login"
  ]);
  assert.match(h.calls[3].init.headers.get("cookie"), /_c_WBKFRo=anonymous/);
  assert.equal(h.calls[3].init.headers.get("new-api-user"), "-1");
});

test("the isolated WAF challenge runner captures acw_sc__v2 and retries the request", async () => {
  const challenge = "<html><script>var arg1='ABC';document.cookie='acw_sc__v2=feedface; expires=Fri, 30 Oct 2026 10:00:00 GMT; path=/';document.location.reload();</script></html>";
  assert.equal(solveWafChallenge(challenge), "acw_sc__v2=feedface");
  assert.equal(solveWafChallenge("<script>document.cookie='acw_sc__v2=unsafe'</script>"), "");
  const h = harness([
    new Response(challenge, { headers: { "content-type": "text/html" } }),
    status()
  ]);
  const result = await h.client.status(account());
  assert.equal(result.data.turnstile_check, false);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].init.headers.get("cookie"), /acw_sc__v2=feedface/);
});

test("Turnstile-enabled status stops before password login", async () => {
  const h = harness([status({ turnstile_check: true, turnstile_site_key: "site-key" })]);
  await assert.rejects(h.client.login(account()), { kind: "captcha" });
  assert.equal(h.calls.length, 1);
  assert.equal(new URL(h.calls[0].url).pathname, "/api/status");
});

test("account reads are read-only and reject another user's data", async () => {
  const h = harness([
    json({ id: 123, quota: 0, used_quota: 500000 }),
    json({ id: 124, quota: 5 })
  ]);
  const state = account({ userId: "123", accessToken: "system-token" });
  assert.equal((await h.client.self(state)).quota, 0);
  await assert.rejects(h.client.self(state), /不一致/);
  assert.ok(h.calls.every(call => call.url.endsWith("/api/user/self") && call.init.method === "GET"));
  assert.equal(h.calls[0].init.headers.get("authorization"), "system-token");
  assert.equal(h.calls[0].init.headers.get("new-api-user"), "123");
  assert.doesNotMatch(JSON.stringify(h.calls.map(call => call.init.body)), /private-password/);
});

test("profile acquisition enriches verified identity and retains rotated WAF/session cookies", async () => {
  const h = harness([
    json({ id: 123, username: "site-alice", email: "alice@example.test" }, {
      "set-cookie": "session=rotated; HttpOnly"
    })
  ]);
  const source = account({ userId: "123", session: "session=original; acw_tc=waf", label: "display-alias" });
  const result = await h.client.profile(source);
  assert.equal(result.profileVerified, true);
  assert.equal(result.account.email, "alice@example.test");
  assert.equal(result.account.username, "site-alice");
  assert.equal(result.account.label, "display-alias");
  assert.match(result.account.session, /session=rotated/);
  assert.match(result.account.session, /acw_tc=waf/);
  assert.equal(source.session, "session=original; acw_tc=waf");
  assert.equal(h.calls.length, 1);
});

test("wrong-user profile is not a session update", async () => {
  const h = harness([json({ id: 124, username: "bob" }, { "set-cookie": "session=wrong-user" })]);
  const state = account({ userId: "123", session: "session=original" });
  await assert.rejects(h.client.profile(state), /不一致/);
  assert.equal(state.session, "session=original");
});

test("site errors are classified without exposing supplied credentials", async t => {
  const cases = [
    ["captcha", () => new Response('<html><meta name="aliyun_waf_aa">captcha</html>')],
    ["credentials", () => rawJson({ success: false, message: "用户名或密码错误 private-password" })],
    ["waf", () => new Response('<html><script>var arg1 = "challenge"</script></html>', {
      headers: { "content-type": "text/html" }
    })],
    ["inactive", () => rawJson({ success: false, message: "签到活动未开启" })],
    ["unavailable", () => new Response("<html>Bad gateway</html>", { status: 502 })],
    ["rate-limit", () => rawJson({ success: false, message: "请求次数过多" }, 429)]
  ];
  for (const [kind, response] of cases) {
    await t.test(kind, async () => {
      const steps = kind === "waf"
        ? [status(), response(), new Response("<html>login page</html>"), response()]
        : [status(), response()];
      const h = harness(steps);
      await assert.rejects(h.client.login(account()), error => {
        assert.equal(error.kind, kind);
        assert.doesNotMatch(error.message, /private-password|private-model-key/);
        return true;
      });
      assert.equal(h.calls.length, kind === "waf" ? 4 : 2);
    });
  }
});

test("API key selection reads existing active keys without creating or rotating credentials", async () => {
  const h = harness([json({ items: [key], total: 1 }), json(key)]);
  const state = account({ userId: "123", session: "session=site-session" });
  assert.deepEqual(await h.client.selectKey(state), { key: key.key, keyId: "7" });
  assert.deepEqual(await h.client.selectKey(state, "7"), { key: key.key, keyId: "7" });
  assert.ok(h.calls.every(call => call.init.method === "GET"));
  assert.ok(h.calls.every(call => !call.url.includes("/api/user/token")));
  assert.equal(h.calls[1].url, "https://anyrouter.top/api/token/7");
});

test("ambiguous, truncated, expired, exhausted and masked keys cannot silently win selection", async t => {
  for (const [name, data] of [
    ["ambiguous", { items: [key, { ...key, id: 8 }], total: 2 }],
    ["truncated", { items: [key], total: 20 }],
    ["expired", { items: [{ ...key, expired_time: 1 }] }],
    ["exhausted", { items: [{ ...key, unlimited_quota: false, remain_quota: 0 }] }],
    ["masked", { items: [{ ...key, key: "sk-****" }] }]
  ]) {
    await t.test(name, async () => {
      const h = harness([json(data)]);
      await assert.rejects(
        h.client.selectKey(account({ userId: "123", session: "session=x" })),
        { kind: "selection" }
      );
      assert.equal(h.calls.length, 1);
    });
  }
});

test("sign_in sends only the site session and New-API-User with an empty JSON body", async () => {
  const h = harness([
    rawJson({ success: true, message: "签到成功", data: { reward: 25 } })
  ]);
  const state = account({
    userId: "123",
    session: "session=site-session; acw_tc=waf; acw_sc__v2=challenge; cdn_sec_tc=cdn",
    accessToken: "must-not-be-sent"
  });
  const result = await h.client.signIn(state);
  assert.equal(result.success, true);
  assert.equal(result.message, "签到成功");
  assert.equal(result.cookies, state.session);
  const call = h.calls[0];
  assert.equal(call.url, "https://anyrouter.top/api/user/sign_in");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.get("cookie"), state.session);
  assert.equal(call.init.headers.get("new-api-user"), "123");
  assert.equal(call.init.headers.get("x-requested-with"), "XMLHttpRequest");
  assert.equal(call.init.headers.has("authorization"), false);
  assert.deepEqual(JSON.parse(call.init.body), {});
});

test("sign_in results distinguish claimed, done, captcha and inactive", async () => {
  const client = createSiteClient({ fetchImpl: async () => rawJson({ success: true, message: "签到成功" }) });
  const state = account({ userId: "123", session: "session=site-session" });
  assert.equal(client.checkinResult(await client.signIn(state)).lastCheckin.outcome, "claimed");

  const doneClient = createSiteClient({ fetchImpl: async () => rawJson({ success: false, message: "今天已经签到" }) });
  assert.equal(doneClient.checkinResult(await doneClient.signIn(state)).lastCheckin.outcome, "done");

  const captchaClient = createSiteClient({ fetchImpl: async () => rawJson({ success: false, message: "Turnstile token 为空" }) });
  assert.equal(captchaClient.checkinResult(await captchaClient.signIn(state)).lastCheckin.outcome, "captcha");

  const inactiveClient = createSiteClient({ fetchImpl: async () => rawJson({ success: false, message: "签到活动未开启" }) });
  assert.equal(inactiveClient.checkinResult(await inactiveClient.signIn(state)).lastCheckin.outcome, "inactive");
});

test("sign_in HTTP and WAF failures retain a non-retryable classification", async () => {
  const state = account({ userId: "123", session: "session=site-session" });
  for (const [response, kind] of [
    [rawJson({ success: false, message: "无权进行此操作，权限不足" }, 403), "forbidden"],
    [rawJson({ success: false, message: "not found" }, 404), "inactive"],
    [rawJson({ success: false, message: "请求次数过多" }, 429), "rate-limit"],
    [new Response('<html><script>var arg1 = "x"</script></html>', { headers: { "content-type": "text/html" } }), "waf"]
  ]) {
    const client = createSiteClient({ fetchImpl: async () => response.clone() });
    await assert.rejects(client.signIn(state), { kind });
  }
});

test("session handoff accepts AnyRouter cURL and WAF cookies but rejects other sites and unsafe input", async () => {
  const pasted = "curl 'https://anyrouter.top/api/user/self' -H 'New-Api-User: 123' -b 'session=site-secret; acw_tc=waf; acw_sc__v2=challenge' -H 'User-Agent: browser-client' -H 'Sec-CH-UA: \"Chrome\";v=\"143\"' -H 'Authorization: must-not-import' --compressed";
  const handoff = parseSessionHandoff(pasted);
  assert.equal(handoff.userId, "123");
  assert.equal(handoff.session, "session=site-secret; acw_tc=waf; acw_sc__v2=challenge");
  assert.deepEqual(handoff.siteHeaders, { "user-agent": "browser-client", "sec-ch-ua": "\"Chrome\";v=\"143\"" });

  const h = harness([json({ id: 123, username: "alice" })]);
  const result = await h.client.importSession(account({ mode: "session" }), pasted);
  assert.equal(result.account.mode, "session");
  assert.equal(result.account.checkinEnabled, false);
  assert.equal(result.account.password, "");
  assert.equal(result.account.accessToken, "");
  assert.equal(h.calls[0].url, "https://anyrouter.top/api/user/self");
  assert.equal(h.calls[0].init.headers.get("user-agent"), "browser-client");
  assert.equal(h.calls[0].init.headers.get("sec-ch-ua"), "\"Chrome\";v=\"143\"");
  assert.equal(h.calls[0].init.headers.get("authorization"), null);

  for (const text of [
    "curl 'https://github.com/api/user/self' -H 'cookie: session=github' -H 'new-api-user: 123'",
    "curl 'https://connect.linux.do/api/user/self' -H 'cookie: session=linuxdo' -H 'new-api-user: 123'",
    "curl 'https://other.example/api/user/self' -H 'cookie: session=other' -H 'new-api-user: 123'",
    "curl 'https://anyrouter.top/api/token/' -H 'cookie: session=site' -H 'new-api-user: 123'",
    '{"cookie":"session=site"}',
    '{"cookie":"session=site\\r\\nX-Secret: x","userId":"123"}',
    "{}"
  ]) {
    assert.throws(() => parseSessionHandoff(text));
  }

  const legacy = harness([]);
  await assert.rejects(
    legacy.client.importSession(account({ siteURL: "https://legacy.example" }), '{"cookie":"session=site","userId":"123"}'),
    /AnyRouter|session/
  );
});

test("site operations reject API-only and unknown origins", async () => {
  const fcapp = "https://a-ocnfniawgw.cn-shanghai.fcapp.run";
  for (const state of [
    account({ userId: "123", session: "session=site", siteURL: fcapp }),
    account({ userId: "123", session: "session=site", siteURL: "https://legacy.example" })
  ]) {
    const h = harness([]);
    await assert.rejects(h.client.self(state), /只支持 anyrouter\.top/);
    assert.equal(h.calls.length, 0);
  }
  const h = harness([json({ id: 123, quota: 0 })]);
  await h.client.self(account({ userId: "123", session: "session=site", apiBase: `${fcapp}/v1` }));
  assert.equal(h.calls[0].url, "https://anyrouter.top/api/user/self");
});

test("session import fails closed when the selected site returns another UID", async () => {
  const h = harness([json({ id: 456, username: "other" })]);
  await assert.rejects(
    h.client.importSession(account(), '{"cookie":"session=site","userId":"123"}'),
    /不一致/
  );
});

test("cookie merging handles Expires commas, WAF rotation and deletion", () => {
  const headers = new Headers();
  headers.append("set-cookie", "session=new; Expires=Wed, 28 Oct 2026 20:00:00 GMT; HttpOnly");
  headers.append("set-cookie", "acw_tc=waf; Path=/");
  headers.append("set-cookie", "old=gone; Max-Age=0");
  assert.equal(mergeCookies("session=old; old=old", headers), "session=new; acw_tc=waf");
});

test("missing or malformed quota values are not zero", () => {
  for (const value of [null, undefined, "", " ", false, true, "not-a-number", Infinity, {}]) {
    assert.equal(quotaNumber(value), null);
  }
  assert.equal(quotaNumber("0"), 0);
  assert.equal(quotaNumber(0), 0);
  assert.equal(quotaNumber("123.5"), 123.5);
});

test("account custom headers override native defaults but cannot leak account credentials", () => {
  for (const header of [
    "Authorization: token",
    "Cookie: session=x",
    "New-Api-User: 123",
    "X-Api-Key: key"
  ]) {
    assert.throws(() => customHeaders(header), /由所选账号或传输层管理/);
  }
  const state = account({
    headers: "X-Account: alice\nX-Selected-Model: default\nUser-Agent: custom-client"
  });
  for (const [protocol, expected] of [
    ["responses", "authorization"],
    ["chat", "authorization"],
    ["anthropic", "x-api-key"],
    ["gemini", "x-goog-api-key"]
  ]) {
    const headers = inferenceHeaders(
      state,
      {
        "x-selected-model": "native-model",
        cookie: "session=never-forward",
        authorization: "gateway-key",
        "new-api-user": "123"
      },
      protocol
    );
    assert.equal(headers.get("x-selected-model"), "default");
    assert.equal(headers.get("x-account"), "alice");
    assert.equal(headers.get("user-agent"), "custom-client");
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("new-api-user"), null);
    assert.equal(headers.get(expected), expected === "authorization" ? "Bearer private-model-key" : "private-model-key");
    assert.equal(["authorization", "x-api-key", "x-goog-api-key"].filter(name => headers.has(name)).length, 1);
  }
});

test("site requests use browser headers and site-only overrides", async () => {
  const read = harness([json({ id: 123, quota: 0 })]);
  await read.client.self(account({ userId: "123", accessToken: "system-token" }));
  const headers = read.calls[0].init.headers;
  assert.match(headers.get("user-agent"), /^Mozilla\/5\.0 .*Chrome\//);
  assert.equal(headers.get("accept"), "application/json, text/plain, */*");
  assert.match(headers.get("accept-language"), /^zh-CN/);
  assert.match(headers.get("sec-ch-ua"), /Chrome/);
  assert.equal(headers.get("sec-fetch-site"), "same-origin");
  assert.equal(headers.get("referer"), "https://anyrouter.top/");
  assert.equal(headers.has("origin"), false);

  const login = harness([
    status(),
    json({ id: 123, username: "alice" }, { "set-cookie": "session=site-session; Path=/" })
  ]);
  await login.client.login(account());
  assert.equal(login.calls[0].init.headers.get("origin"), null);
  assert.equal(login.calls[1].init.headers.get("origin"), "https://anyrouter.top");

  const override = harness([json({ id: 123, quota: 0 })]);
  await override.client.self(account({
    userId: "123",
    accessToken: "system-token",
    headers: "User-Agent: my-client\nAccept: application/xml"
  }));
  assert.equal(override.calls[0].init.headers.get("user-agent"), "my-client");
  assert.equal(override.calls[0].init.headers.get("accept"), "application/xml");
});

test("session handoff accepts Chrome's `curl --url` output shape", async () => {
  const pasted = [
    "curl --url '" + SITES.top + "/api/user/self' \\",
    "  -H 'accept: application/json, text/plain, */*' \\",
    "  -H 'cache-control: no-store' \\",
    "  -b 'acw_tc=waf; cdn_sec_tc=cdn; acw_sc__v2=solve; session=site-secret' \\",
    "  -H 'new-api-user: 83237' \\",
    "  -H 'pragma: no-cache' \\",
    "  -H 'priority: u=1, i' \\",
    "  -H 'referer: " + SITES.top + "/console/personal' \\",
    "  -H 'sec-ch-ua: \"Not:A-Brand\";v=\"8\", \"Chromium\";v=\"156\", \"Google Chrome\";v=\"156\"' \\",
    "  -H 'sec-fetch-mode: cors' \\",
    "  -H 'user-agent: browser-client'",
  ].join("\n");
  const handoff = parseSessionHandoff(pasted);
  assert.equal(handoff.userId, "83237");
  assert.match(handoff.session, /^acw_tc=waf; cdn_sec_tc=cdn; acw_sc__v2=solve; session=site-secret$/);
  assert.equal(handoff.siteHeaders["user-agent"], "browser-client");
  assert.throws(
    () => parseSessionHandoff(pasted.replace("/api/user/self", "/api/token/")),
    /\/api\/user\/self/
  );
});
