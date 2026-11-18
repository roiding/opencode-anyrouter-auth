import assert from "node:assert/strict";
import test from "node:test";
import { createProvider } from "../lib/provider.mjs";
import { readAccount, saveAccount } from "../lib/accounts.mjs";
import { buildCatalog, protocolForModel, protocolOfURL } from "../lib/catalog.mjs";
import { createFilteredFetch } from "../lib/responses-filter.mjs";

const json = (data, headers = {}) => new Response(JSON.stringify({ success: true, data }), {
  headers: { "content-type": "application/json", ...headers }
});
const rawJson = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers }
});
const key = { id: 7, status: 1, key: "model-secret", unlimited_quota: true };
const status = (extra = {}) => json({ turnstile_check: false, quota_per_unit: 500000, ...extra });
const state = (extra = {}) => ({
  mode: "password",
  site: "top",
  siteURL: "https://anyrouter.top",
  key: "model-secret",
  keyId: "7",
  userId: "123",
  username: "alice",
  password: "site-secret",
  session: "session=original; acw_tc=waf",
  accessToken: "",
  headers: "",
  checkinEnabled: true,
  ...extra
});
const stored = extra => saveAccount(state(extra));
const asAuth = ({ type, ...rest }) => ({ type: "oauth", ...rest });

test("login UI exposes password, OAuth/session, access-token and API-key methods", async () => {
  const hooks = await createProvider();
  const [password, github, linuxdo, session, token, api] = hooks.auth.methods;
  assert.ok(hooks.auth.icon.startsWith("data:image/png;base64,"));
  assert.deepEqual(
    hooks.auth.methods.map(method => method.type),
    ["api", "oauth", "oauth", "oauth", "api", "api"]
  );
  assert.equal(password.keyless, true);
  assert.equal(token.keyless, true);
  assert.equal(api.authorize, undefined);
  assert.equal(password.prompts.find(prompt => prompt.key === "password").type, "password");
  assert.equal(token.prompts.find(prompt => prompt.key === "accessToken").type, "password");
  assert.equal(password.prompts.some(prompt => prompt.key === "site"), false);
  const apiEndpoint = password.prompts.find(prompt => prompt.key === "apiEndpoint");
  assert.equal(apiEndpoint.type, "select");
  assert.deepEqual(apiEndpoint.options.map(option => option.value), ["top", "fcapp"]);
  assert.equal(apiEndpoint.when, undefined);
  assert.ok(password.prompts.some(prompt => prompt.key === "checkinEnabled"));
  assert.ok(session.prompts.some(prompt => prompt.key === "checkinEnabled"));
  for (const method of [github, linuxdo, session, api]) {
    assert.ok(!method.prompts.some(prompt => ["username", "password", "accessToken", "cookie", "userId"].includes(prompt.key)));
  }
  for (const method of hooks.auth.methods) {
    assert.equal(method.prompts.find(prompt => prompt.key === "headers").when.key, "advanced");
  }
  for (const method of [password, github, linuxdo, session, token]) {
    assert.ok(!method.prompts.some(prompt => ["email", "label", "alias"].includes(prompt.key)));
  }
  const email = api.prompts.find(prompt => prompt.key === "email");
  assert.match(email.message, /邮箱/);
  assert.equal(email.validate("alice@example.test"), undefined);
  assert.equal(email.validate(""), undefined);
  assert.ok(email.validate("maodou38"), "an API-key name must not mistake a display remark for an email");
});

test("password login reads status, logs in, verifies profile and selects an existing key", async t => {
  for (const endpoint of ["top", "fcapp"]) {
    for (const enabled of ["no", "yes"]) {
      await t.test(`${endpoint}: ${enabled}`, async () => {
        const calls = [];
        const hooks = await createProvider({}, {}, {
          fetchImpl: async (url, init) => {
            const pathname = new URL(url).pathname;
            calls.push({ url, pathname, init });
            if (pathname === "/api/status") return status();
            if (pathname === "/api/user/login") {
              return json({ id: 123, username: "alice" }, {
                "set-cookie": "session=signed-in; HttpOnly"
              });
            }
            if (pathname === "/api/user/self") {
              return json({ id: 123, username: "alice", email: "alice@example.test" });
            }
            if (pathname === "/api/token/") return json({ items: [key], total: 1 });
            assert.fail("unexpected path " + pathname);
          }
        });
        const result = await hooks.auth.methods[0].authorize({
          apiEndpoint: endpoint,
          username: "alice",
          password: "site-secret",
          checkinEnabled: enabled
        });
        assert.equal(result.type, "success", result.error);
        const account = readAccount(asAuth(result));
        assert.equal(account.key, "model-secret");
        assert.equal(account.checkinEnabled, enabled === "yes");
        assert.equal(account.password, enabled === "yes" ? "site-secret" : "");
        assert.equal(account.session, "session=signed-in");
        assert.equal(account.email, "alice@example.test");
        assert.equal(account.apiBase, endpoint === "top"
          ? "https://anyrouter.top/v1"
          : "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1");
        assert.equal(result.accountId, "alice@example.test");
        assert.equal(result.uid, "anyrouter:123");
        assert.deepEqual(calls.map(call => call.pathname), [
          "/api/status",
          "/api/user/login",
          "/api/user/self",
          "/api/token/"
        ]);
        assert.equal(calls[1].init.headers.get("cookie"), null);
        assert.ok(calls.every(call => new URL(call.url).origin === "https://anyrouter.top"));
        assert.ok(!calls.some(call => call.url.includes("/api/user/token")));
      });
    }
  }
});

test("Turnstile blocks password login without sending credentials", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return status({ turnstile_check: true, turnstile_site_key: "site-key" });
    }
  });
  const result = await hooks.auth.methods[0].authorize({
    username: "alice",
    password: "site-secret",
    checkinEnabled: "yes"
  });
  assert.equal(result.type, "failed");
  assert.match(result.error, /Turnstile/);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/api/status");
});

test("access-token login is read-only and cannot opt into check-in", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, {
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, init });
      if (pathname === "/api/user/self") return json({ id: 123, username: "alice" });
      if (pathname === "/api/token/") return json({ items: [key], total: 1 });
      assert.fail("unexpected path " + pathname);
    }
  });
  const result = await hooks.auth.methods[4].authorize({
    accessToken: "system-secret",
    userId: "123",
    checkinEnabled: "yes",
    password: "must-not-store"
  });
  assert.equal(result.type, "success", result.error);
  assert.equal(readAccount(asAuth(result)).checkinEnabled, false);
  assert.doesNotMatch(JSON.stringify(result), /must-not-store/);
  assert.ok(calls.every(call => call.init.method === "GET"));
  assert.equal(calls[0].init.headers.get("authorization"), "system-secret");
  assert.equal(calls[0].init.headers.get("new-api-user"), "123");
});

test("GitHub, LinuxDO and browser-session methods use a site-session handoff, not a consumed OAuth code", async t => {
  for (const index of [1, 2, 3]) {
    await t.test(String(index), async () => {
      const calls = [];
      const hooks = await createProvider({}, {}, {
        fetchImpl: async (url, init) => {
          const pathname = new URL(url).pathname;
          calls.push({ pathname, init });
          if (pathname === "/api/user/self") return json({ id: 123, username: "alice" });
          if (pathname === "/api/token/") return json({ items: [key], total: 1 });
          assert.fail("unexpected path " + pathname);
        }
      });
      const flow = await hooks.auth.methods[index].authorize({
        checkinEnabled: "yes"
      });
      assert.equal(flow.url, "https://anyrouter.top/login");
      assert.equal(calls.length, 0);
      const result = await flow.callback(
        '{"cookie":"session=site-only; acw_tc=waf","userId":"123"}'
      );
      assert.equal(result.type, "success", result.error);
      const account = readAccount(asAuth(result));
      assert.equal(account.mode, ["github", "linuxdo", "session"][index - 1]);
      assert.equal(account.checkinEnabled, true);
      assert.equal(account.key, "model-secret");
      assert.equal(account.session, "session=site-only; acw_tc=waf");
      assert.equal(account.password, "");
      assert.deepEqual(calls.map(call => call.pathname), ["/api/user/self", "/api/token/"]);
      assert.equal((await flow.callback('{"cookie":"session=site-only","userId":"123"}')).type, "failed");
    });
  }
});

test("all site login paths use verified profile identity and never a display alias", async t => {
  const ways = [
    [0, "password"],
    [1, "github"],
    [2, "linuxdo"],
    [3, "session"],
    [4, "access-token"]
  ];
  for (const [index, way] of ways) {
    for (const email of ["real@example.test", ""]) {
      await t.test(`${way}: ${email ? "email" : "username fallback"}`, async () => {
        const calls = [];
        const hooks = await createProvider({}, {}, {
          fetchImpl: async (url, init) => {
            const pathname = new URL(url).pathname;
            calls.push({ pathname, init });
            if (pathname === "/api/status") return status();
            if (pathname === "/api/user/login") {
              return json({ id: 123, username: "from-login" }, {
                "set-cookie": "session=verified; HttpOnly"
              });
            }
            if (pathname === "/api/user/self") {
              return json({ id: 123, username: "verified-site-name", email });
            }
            if (pathname === "/api/token/") return json({ items: [key], total: 1 });
            assert.fail("unexpected path " + pathname);
          }
        });
        const inputs = {
          email: "maodou38",
          username: "login@example.test",
          password: "site-secret",
          accessToken: "system-secret",
          userId: "123",
          checkinEnabled: "no"
        };
        const method = hooks.auth.methods[index];
        const authorized = await method.authorize(inputs);
        const result = method.type === "oauth"
          ? await authorized.callback('{"cookie":"session=verified; acw_tc=waf","userId":"123"}')
          : authorized;
        assert.equal(result.type, "success", result.error);
        assert.equal(result.accountId, email || "verified-site-name");
        assert.equal(result.uid, "anyrouter:123");
        const account = readAccount(asAuth(result));
        assert.equal(account.email, email);
        assert.equal(account.label, "maodou38");
        assert.equal(account.username, "verified-site-name");
        assert.equal(calls.filter(call => call.pathname === "/api/user/self").length, 1);
        assert.equal(calls.filter(call => call.pathname === "/api/token/").length, 1);
      });
    }
  }
});

test("profile verification fails closed before key lookup or persistence", async t => {
  for (const failure of ["wrong-user", "unavailable"]) {
    await t.test(failure, async () => {
      const calls = [];
      const hooks = await createProvider({
        client: { auth: { set() { assert.fail("a failed login cannot persist credentials"); } } }
      }, {}, {
        fetchImpl: async url => {
          const pathname = new URL(url).pathname;
          calls.push(pathname);
          if (pathname === "/api/status") return status();
          if (pathname === "/api/user/login") {
            return json({ id: 123, username: "alice" }, {
              "set-cookie": "session=verified"
            });
          }
          if (pathname === "/api/user/self") {
            return failure === "wrong-user"
              ? json({ id: 456, username: "bob", email: "other@example.test" })
              : new Response("Unavailable", { status: 503 });
          }
          assert.fail("unexpected path " + pathname);
        }
      });
      const result = await hooks.auth.methods[0].authorize({
        username: "alice",
        password: "site-secret",
        checkinEnabled: "no"
      });
      assert.equal(result.type, "failed");
      assert.equal(result.access, undefined);
      assert.equal(result.refresh, undefined);
      assert.deepEqual(calls, ["/api/status", "/api/user/login", "/api/user/self"]);
      assert.doesNotMatch(result.error, /site-secret|session=verified|other@example/);
    });
  }
});

test("API-key-only accounts never call the site for quota or check-in", async () => {
  const hooks = await createProvider({}, {}, {
    fetchImpl: () => {
      throw new Error("No site calls allowed");
    }
  });
  const auth = { type: "api", key: "model-secret", metadata: { site: "top" } };
  const usage = await hooks.auth.usage(async () => auth, {});
  assert.deepEqual(usage.windows, []);
  assert.equal(usage.balance, undefined);
  assert.equal(usage.signIn, "kept");
  assert.equal((await hooks.auth.checkin(async () => auth, {})).outcome, "ineligible");
});

test("read-only wallet data informs native balance routing without fabricated reset windows", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json({ id: 123, username: "alice", quota: 1250000, used_quota: 999999999 });
    }
  });
  const usage = await hooks.auth.usage(async () => stored(), {});
  assert.equal(usage.balance, "$2.50");
  assert.equal(usage.windows[0].balance, 2.5);
  assert.equal(usage.windows[0].unit, "USD");
  for (const name of ["used", "limit", "span", "resetsAt", "resetSecs"]) {
    assert.equal(usage.windows[0][name], undefined);
  }
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/api/user/self"]);
});

test("missing quota and WAF failures remain unknown, never password-login fallbacks", async t => {
  for (const response of [
    () => json({ id: 123, used_quota: 100 }),
    () => new Response('<html><script>var arg1 = "challenge"</script></html>', {
      headers: { "content-type": "text/html" }
    })
  ]) {
    await t.test("unknown balance", async () => {
      const calls = [];
      const hooks = await createProvider({}, {}, {
        fetchImpl: async url => {
          calls.push(url);
          return response();
        }
      });
      const usage = await hooks.auth.usage(async () => stored(), {});
      assert.equal(usage.balance, undefined);
      assert.deepEqual(usage.windows, []);
      assert.equal(usage.signIn, "kept");
      assert.equal(calls.length, 1);
      assert.ok(calls[0].endsWith("/api/user/self"));
    });
  }
});

test("daily check-in is a separate sign_in call, deduplicated and persisted without invalidating inference", async () => {
  let auth = stored();
  let calls = 0;
  let now = Date.parse("2026-10-28T08:00:00Z");
  const writes = [];
  const hooks = await createProvider({
    client: {
      auth: {
        set: async value => {
          writes.push(value);
          auth = value.body;
        }
      }
    }
  }, {}, {
    now: () => now,
    fetchImpl: async (url, init) => {
      calls++;
      const pathname = new URL(url).pathname;
      if (pathname === "/api/status") return status();
      if (pathname === "/api/user/login") {
        return json({ id: 123, username: "alice" }, {
          "set-cookie": "session=fresh; HttpOnly"
        });
      }
      if (pathname === "/api/user/sign_in") {
        assert.match(init.headers.get("cookie"), /session=fresh/);
        assert.match(init.headers.get("cookie"), /acw_tc=waf/);
        return rawJson({ success: true, message: "签到成功", data: { reward: 25 } });
      }
      assert.fail("unexpected path " + pathname);
    }
  });
  const results = await Promise.all([
    hooks.auth.checkin(async () => auth, {}),
    hooks.auth.checkin(async () => auth, {})
  ]);
  assert.deepEqual(results.map(result => result.outcome), ["claimed", "done"]);
  assert.equal(calls, 3, "status + login + sign_in only once");
  assert.equal(writes[0].path.id, "anyrouter");
  assert.match(readAccount(auth).session, /session=fresh/);
  assert.match(readAccount(auth).session, /acw_tc=waf/);
  assert.equal(auth.access, "model-secret");
  assert.equal(results[0].signIn, undefined);
  assert.equal((await hooks.auth.checkin(async () => auth, {})).outcome, "done");
  assert.equal(calls, 3);
  now = Date.parse("2026-10-28T16:00:00Z");
  assert.equal((await hooks.auth.checkin(async () => auth, {})).outcome, "claimed");
  assert.equal(calls, 6);
});

test("session-mode check-in verifies the session and calls sign_in without a password", async () => {
  let auth = stored({ mode: "session", password: "", checkinEnabled: true });
  const calls = [];
  const writes = [];
  const hooks = await createProvider({
    client: { auth: { set: async value => { writes.push(value); auth = value.body; } } }
  }, {}, {
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      if (pathname === "/api/user/self") return json({ id: 123, username: "alice" });
      if (pathname === "/api/user/sign_in") {
        return rawJson({ success: true, message: "签到成功" });
      }
      assert.fail("unexpected path " + pathname);
    }
  });
  const result = await hooks.auth.checkin(async () => auth, {});
  assert.equal(result.outcome, "claimed");
  assert.deepEqual(calls, ["/api/user/self", "/api/user/sign_in"]);
  assert.equal(writes.length, 1);
  assert.equal(readAccount(auth).mode, "session");
  assert.equal(readAccount(auth).password, "");
});

test("check-in terminal outcomes stop same-day retries and failed outcomes do not", async t => {
  const cases = [
    ["done", () => rawJson({ success: false, message: "今天已经签到" }), "done"],
    ["captcha", () => status({ turnstile_check: true }), "captcha"],
    ["ineligible", () => rawJson({ success: false, message: "无权进行此操作，权限不足" }, 403), "ineligible"],
    ["inactive", () => rawJson({ success: false, message: "签到活动未开启" }, 404), "inactive"],
    ["failed-http-429", () => rawJson({ success: false, message: "请求次数过多" }, 429), "failed"],
    ["failed-http-200", () => rawJson({ success: false, message: "请求次数过多" }), "failed"]
  ];
  for (const [name, response, expected] of cases) {
    await t.test(name, async () => {
      let auth = stored();
      let calls = 0;
      const writes = [];
      const hooks = await createProvider({
        client: { auth: { set: async value => { writes.push(value); auth = value.body; } } }
      }, {}, {
        fetchImpl: async (url, init) => {
          calls++;
          const pathname = new URL(url).pathname;
          if (pathname === "/api/status") return name === "captcha" ? response() : status();
          if (pathname === "/api/user/login") {
            return json({ id: 123, username: "alice" }, {
              "set-cookie": "session=fresh"
            });
          }
          if (pathname === "/api/user/sign_in") return response();
          assert.fail("unexpected path " + pathname);
        }
      });
      const first = await hooks.auth.checkin(async () => auth, {});
      assert.equal(first.outcome, expected);
      const firstCalls = calls;
      const second = await hooks.auth.checkin(async () => auth, {});
      if (expected === "failed") {
        assert.equal(second.outcome, "failed");
        assert.ok(calls > firstCalls);
      } else {
        assert.equal(second.outcome, "done");
        assert.equal(calls, firstCalls);
      }
      if (expected === "failed") assert.equal(writes.length, 0);
    });
  }
});

test("wrong-user check-in never replaces the selected account's credentials", async () => {
  let writes = 0;
  const hooks = await createProvider({
    client: { auth: { set: () => { writes++; } } }
  }, {}, {
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/status") return status();
      if (pathname === "/api/user/login") {
        return json({ id: 999, username: "other" }, {
          "set-cookie": "session=other"
        });
      }
      assert.fail("unexpected path " + pathname);
    }
  });
  const result = await hooks.auth.checkin(async () => stored(), {});
  assert.equal(result.outcome, "failed");
  assert.equal(result.signIn, undefined);
  assert.equal(writes, 0);
});

test("model catalog honors AnyRouter protocol families and explicit overrides", () => {
  const explicit = {
    models: {
      friendly: {
        id: "server-model",
        name: "My model",
        provider: {
          npm: "@ai-sdk/openai-compatible",
          api: "https://custom.example/prefix"
        },
        headers: { "x-selected": "custom" },
        limit: { context: 1234 }
      }
    }
  };
  const provider = { models: { friendly: { api: { id: "server-model" }, headers: { "x-existing": "keep" } } } };
  const rows = [
    { id: "server-model", supported_endpoint_types: ["anthropic"] },
    { id: "claude-opus-5-5" },
    { id: "gemini-2.5-pro" },
    { id: "gpt-6-astra-cc-format" }
  ];
  const out = buildCatalog(rows, provider, state(), explicit, [{ model_name: "not-authorized" }]);
  assert.deepEqual(Object.keys(out), ["friendly", "claude-opus-5-5", "gemini-2.5-pro", "gpt-6-astra-cc-format"]);
  assert.equal(out.friendly.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(out.friendly.api.url, "https://custom.example/prefix");
  assert.equal(out.friendly.limit.context, 1234);
  assert.equal(out["claude-opus-5-5"].api.npm, "@ai-sdk/anthropic");
  assert.equal(out["gemini-2.5-pro"].api.npm, "@ai-sdk/google");
  assert.equal(out["gpt-6-astra-cc-format"].api.npm, "@ai-sdk/anthropic");
  assert.equal(protocolForModel("gpt-5-codex"), "responses");
  assert.equal(protocolForModel("claude-sonnet-4-5"), "anthropic");
  assert.equal(protocolForModel("gemini-2.5-pro"), "gemini");
});

test("generated AnyRouter provider defaults do not flatten mixed model protocols", () => {
  const account = state({ site: "top", siteURL: "https://anyrouter.top" });
  const provider = { models: {} };
  const explicit = {
    npm: "@ai-sdk/openai",
    api: "https://anyrouter.top/v1",
    models: {}
  };
  const out = buildCatalog([
    { id: "claude-opus-5-5" },
    { id: "gemini-2.5-pro" },
    { id: "gpt-6-astra" }
  ], provider, account, explicit);
  assert.equal(out["claude-opus-5-5"].api.npm, "@ai-sdk/anthropic");
  assert.equal(out["claude-opus-5-5"].api.url, "https://anyrouter.top/v1");
  assert.equal(out["gemini-2.5-pro"].api.npm, "@ai-sdk/google");
  assert.equal(out["gemini-2.5-pro"].api.url, "https://anyrouter.top/v1beta");
  assert.equal(out["gpt-6-astra"].api.npm, "@ai-sdk/openai");
  assert.equal(out["gpt-6-astra"].api.url, "https://anyrouter.top/v1");
});

test("selected API endpoint controls discovery and inference while site calls stay on anyrouter.top", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, {
    loadRegistry: async () => ({}),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const path = new URL(url).pathname;
      if (path === "/v1/models") {
        return new Response(JSON.stringify({
          data: [{ id: "claude-opus-5-5" }, { id: "gemini-2.5-pro" }]
        }), { headers: { "content-type": "application/json" } });
      }
      if (path === "/api/pricing") return json([]);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
  });
  await hooks.config({
    provider: {
      anyrouter: {
        npm: "@ai-sdk/openai",
        api: "https://anyrouter.top/v1",
        models: {}
      }
    }
  });
  const auth = stored({
    site: "top",
    siteURL: "https://anyrouter.top",
    apiBase: "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1"
  });
  const models = await hooks.provider.models({
    id: "anyrouter",
    models: {}
  }, { auth });
  assert.equal(calls[0].url, "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/models");
  assert.equal(calls[1].url, "https://anyrouter.top/api/pricing");
  assert.equal(models["claude-opus-5-5"].api.url, "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1");
  assert.equal(models["gemini-2.5-pro"].api.url, "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1beta");
  const loaded = await hooks.auth.loader(async () => auth, {});
  await loaded.fetch("https://anyrouter.top/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "claude-opus-5-5", input: "hello" })
  });
  assert.equal(calls.at(-1).url, "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1/responses");
});

test("account custom headers override native defaults and loader remaps first-seat URLs", async () => {
  const calls = [];
  const hooks = await createProvider({}, {}, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json({ ok: true });
    }
  });
  const cfg = {
    provider: {
      anyrouter: {
        models: {
          fixed: {
            id: "fixed-api-id",
            provider: {
              api: "https://custom.example/explicit/v1",
              npm: "@ai-sdk/anthropic"
            }
          }
        }
      }
    }
  };
  await hooks.config(cfg);
  const loaded = await hooks.auth.loader(
    async () => stored({ site: "top", siteURL: "https://anyrouter.top", headers: "X-Account: default" }),
    {
      models: {
        default: { api: { id: "wire-id", url: "https://anyrouter.top/v1" } },
        fixed: { api: { id: "fixed-api-id", url: "https://custom.example/explicit/v1" } }
      }
    }
  );
  await loaded.fetch("https://anyrouter.top/v1/responses", {
    method: "POST",
    body: '{"model":"wire-id","input":"unchanged"}',
    headers: { "x-account": "current", "cookie": "session=must-not-leak" }
  });
  await loaded.fetch("https://anyrouter.top/v1beta/models/google-id:generateContent?alt=sse", {
    method: "POST",
    body: '{"contents":[]}'
  });
  const headers = {};
  await hooks["chat.headers"]({ model: { id: "fixed", providerID: "anyrouter" } }, { headers });
  await loaded.fetch("https://anyrouter.top/v1/messages", {
    method: "POST",
    body: '{"model":"fixed-api-id"}',
    headers
  });
  assert.equal(calls[0].url, "https://anyrouter.top/v1/responses");
  assert.equal(calls[0].init.headers.get("x-account"), "default");
  assert.equal(calls[0].init.headers.get("cookie"), null);
  assert.equal(calls[1].url, "https://anyrouter.top/v1beta/models/google-id:generateContent?alt=sse");
  assert.equal(calls[2].url, "https://custom.example/explicit/v1/messages");
  assert.ok(calls.every(call => !call.init.headers.has("x-anyrouter-account-model")));
});

test("changing an account during retry cannot send old request data with the replacement identity", async () => {
  let auth = stored();
  let calls = 0;
  const hooks = await createProvider({}, {}, {
    fetchImpl: async () => {
      calls++;
      auth = stored({ userId: "456", username: "bob", key: "other-key" });
      return rawJson({
        error: { type: "invalid_request_error", code: "invalid_encrypted_content" }
      }, 400);
    }
  });
  const loaded = await hooks.auth.loader(async () => auth, {});
  const send = createFilteredFetch(loaded.fetch, {
    retryProfile: "anyrouter",
    retryDelay: () => 0
  });
  const response = await send("https://anyrouter.top/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "chosen", input: "account-bound prompt" })
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "account_changed");
  assert.equal(calls, 1);
});

test("provider config is not overwritten and discovery failure preserves explicit models", async () => {
  const original = {
    name: "Existing AnyRouter",
    npm: "@ai-sdk/openai-compatible",
    api: "https://custom.example/v1",
    models: { custom: { id: "remote-id" } }
  };
  const cfg = { provider: { anyrouter: original, other: { name: "Unchanged" } } };
  const hooks = await createProvider({}, {}, {
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  await hooks.config(cfg);
  assert.equal(cfg.provider.anyrouter, original);
  assert.deepEqual(Object.keys(cfg.provider), ["anyrouter", "other"]);
  const cached = { custom: { name: "Custom" }, retired: { name: "Stale entry" } };
  const fallback = await hooks.provider.models({ models: cached }, { auth: stored() });
  assert.deepEqual(Object.keys(fallback), ["custom"]);
  assert.equal(fallback[Symbol.for("magpie.fellBack")], true);
});

test("all four inference protocol URLs are recognized, not site or mutation endpoints", () => {
  assert.equal(protocolOfURL("https://site/v1/responses"), "responses");
  assert.equal(protocolOfURL("https://site/v1/chat/completions"), "chat");
  assert.equal(protocolOfURL("https://site/v1/messages"), "anthropic");
  assert.equal(protocolOfURL("https://site/v1beta/models/name:streamGenerateContent?alt=sse"), "gemini");
  for (const path of ["/api/user/login", "/api/user/sign_in", "/v1/files", "/v1/responses/compact"]) {
    assert.equal(protocolOfURL("https://site" + path), null);
  }
});
