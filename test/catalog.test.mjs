import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog } from "../lib/catalog.mjs";
import { createSiteClient } from "../lib/site-client.mjs";

const json = (data, status = 200) => new Response(JSON.stringify({ success: true, data }), {
  status, headers: { "content-type": "application/json" }
});
const account = (extra = {}) => ({
  siteURL: "https://anyrouter.top", key: "inference-secret", userId: "123",
  session: "session=site-secret; acw_tc=waf-secret", accessToken: "", ...extra
});
const fallbackMarker = Symbol.for("magpie.fellBack");

function harness(respond, settings = {}) {
  const calls = [];
  let registryReads = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  const catalog = createCatalog({
    site: createSiteClient({ fetchImpl }), fetchImpl,
    explicit: () => settings, compatibility: () => true,
    loadRegistry: async () => {
      registryReads++;
      return { anyrouter: { models: { "registry-only": { context_length: 100000 } } } };
    }
  });
  return { catalog, calls, get registryReads() { return registryReads; } };
}

test("official endpoints discover pricing model names and preserve routing, metadata and explicit overrides", async context => {
  for (const apiBase of ["", "https://anyrouter.top/v1", "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1"]) {
    await context.test(apiBase || "default endpoint", async () => {
      const settings = {
        api: "https://anyrouter.top/v1", npm: "@ai-sdk/openai",
        models: {
          friendly: { id: "gpt-catalog", name: "Friendly", limit: { input: 7000 } },
          hidden: { disabled: true },
          manual: { provider: { npm: "@ai-sdk/openai-compatible", api: "https://custom.example/v1" } }
        }
      };
      const state = account({ apiBase, siteHeaders: { "user-agent": "imported-browser", "sec-ch-ua": "imported-client" } });
      const fixture = harness(() => json([
        { model_name: "gpt-catalog", id: 42, display_name: "Catalog model", context_length: 10000,
          max_input_tokens: 8000, max_output_tokens: 2000, tool_call: false,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }], supported_endpoint_types: ["responses"] },
        { model_name: "claude-catalog" }, { model_name: "gemini-catalog" },
        { model_name: "custom-chat", supported_endpoint_types: ["chat-completions"] },
        { model_name: "hidden" }, null, {}, { model_name: 12 }, { model_name: "" }, { model_name: "   " }
      ]), settings);
      const models = await fixture.catalog({ id: "anyrouter", models: {} }, state);
      assert.deepEqual(Object.keys(models), ["friendly", "claude-catalog", "gemini-catalog", "custom-chat", "manual"]);
      assert.equal(models.friendly.api.id, "gpt-catalog");
      assert.equal(models.friendly.name, "Friendly");
      assert.deepEqual(models.friendly.limit, { context: 10000, input: 7000, output: 2000 });
      assert.equal(models.friendly.capabilities.toolcall, false);
      assert.deepEqual(Object.keys(models.friendly.variants), ["low", "high"]);
      assert.deepEqual(models.friendly.endpoints, ["responses"]);
      assert.equal(models.friendly.api.url, apiBase || "https://anyrouter.top/v1");
      assert.equal(models["claude-catalog"].api.npm, "@ai-sdk/anthropic");
      assert.equal(models["gemini-catalog"].api.npm, "@ai-sdk/google");
      assert.equal(models["gemini-catalog"].api.url, (apiBase || "https://anyrouter.top/v1").replace(/v1$/, "v1beta"));
      assert.equal(models["custom-chat"].api.npm, "@ai-sdk/openai-compatible");
      assert.equal(models.manual.api.url, "https://custom.example/v1");
      assert.equal(models[fallbackMarker], undefined);
      assert.equal(fixture.registryReads, 1);
      assert.equal(fixture.calls.length, 1);
      const { url, init } = fixture.calls[0];
      assert.equal(url, "https://anyrouter.top/api/pricing");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.body, undefined);
      assert.equal(init.headers.get("cookie"), state.session);
      assert.equal(init.headers.get("new-api-user"), "123");
      assert.equal(init.headers.get("authorization"), null);
      assert.equal(init.headers.get("referer"), "https://anyrouter.top/pricing");
      assert.equal(init.headers.get("cache-control"), "no-store");
      assert.equal(init.headers.get("user-agent"), "imported-browser");
      assert.equal(init.headers.get("sec-ch-ua"), "imported-client");
      assert.equal(init.headers.get("originator"), null);
      assert.doesNotMatch(JSON.stringify([...init.headers]), /inference-secret/);
    });
  }
});

test("API-key-only and access-token accounts use separate pricing authentication", async context => {
  for (const [name, credentials, expectedToken, expectedUser] of [
    ["API key", { userId: "", session: "" }, null, "-1"],
    ["system access token", { session: "", accessToken: "site-token" }, "site-token", "123"]
  ]) {
    await context.test(name, async () => {
      const fixture = harness(() => json([{ model_name: "gpt-catalog" }]));
      const models = await fixture.catalog({ models: {} }, account(credentials));
      assert.deepEqual(Object.keys(models), ["gpt-catalog"]);
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.calls[0].init.headers.get("authorization"), expectedToken);
      assert.equal(fixture.calls[0].init.headers.get("new-api-user"), expectedUser);
      assert.equal(fixture.calls[0].init.headers.get("cookie"), null);
      assert.doesNotMatch(JSON.stringify([...fixture.calls[0].init.headers]), /inference-secret/);
    });
  }
});

test("pricing failures preserve explicit models without probing inference or expiring its key", async context => {
  for (const [name, respond] of [
    ["unauthorized", () => json([], 401)],
    ["forbidden", () => json([], 403)],
    ["unavailable", () => json([], 503)],
    ["unsuccessful", () => new Response(JSON.stringify({ success: false, message: "session expired" }))],
    ["invalid JSON", () => new Response("not JSON")],
    ["invalid payload", () => json({ items: [] })],
    ["invalid rows", () => json([null, { id: "not-a-pricing-name" }, { model_name: " " }])],
    ["network failure", () => { throw new Error("offline"); }]
  ]) {
    await context.test(name, async () => {
      const fixture = harness(respond, { models: { manual: {}, hidden: { disabled: true } } });
      const models = await fixture.catalog({ models: { manual: { name: "Manual" }, hidden: {}, stale: {} } }, account());
      assert.deepEqual(Object.keys(models), ["manual"]);
      assert.equal(models.manual.name, "Manual");
      assert.equal(models[fallbackMarker], true);
      assert.deepEqual(fixture.calls.map(call => call.url), ["https://anyrouter.top/api/pricing"]);
      assert.equal(fixture.registryReads, 0);
    });
  }
});

test("empty pricing is a valid empty catalog and no account skips discovery", async () => {
  const fixture = harness(() => json([]));
  assert.deepEqual(Object.keys(await fixture.catalog({ models: {} }, account())), []);
  assert.equal(fixture.calls.length, 1);
  assert.equal((await fixture.catalog({ models: {} }, null))[fallbackMarker], undefined);
  assert.equal((await fixture.catalog({ models: {} }, account({ key: "" })))[fallbackMarker], undefined);
  assert.equal(fixture.calls.length, 1);
});

test("pricing discovery reuses bounded site WAF challenge handling and retains the account session", async () => {
  let attempts = 0;
  const fixture = harness(() => ++attempts === 1
    ? new Response("<script>var arg1='ABC';document.cookie='acw_sc__v2=feedface; path=/';document.location.reload();</script>", {
      headers: { "content-type": "text/html", "set-cookie": "cdn_sec_tc=rotated; Path=/" }
    })
    : json([{ model_name: "gpt-catalog" }]));
  const models = await fixture.catalog({ models: {} }, account());
  assert.deepEqual(Object.keys(models), ["gpt-catalog"]);
  assert.equal(fixture.calls.length, 2);
  for (const call of fixture.calls) assert.equal(call.url, "https://anyrouter.top/api/pricing");
  const headers = fixture.calls[1].init.headers;
  assert.match(headers.get("cookie"), /session=site-secret/);
  assert.match(headers.get("cookie"), /cdn_sec_tc=rotated/);
  assert.match(headers.get("cookie"), /acw_sc__v2=feedface/);
  assert.equal(headers.get("new-api-user"), "123");
  assert.equal(headers.get("authorization"), null);
});

test("custom gateways retain model discovery and pricing cannot expand their catalog", async () => {
  const fixture = harness(url => url === "https://gateway.example/v1/models"
    ? new Response(JSON.stringify({ data: [{ id: "gateway-model" }] }))
    : json([{ model_name: "gateway-model", context_length: 12000 }, { model_name: "pricing-only" }]), {
    api: "https://gateway.example/v1"
  });
  const models = await fixture.catalog({ models: {} }, account());
  assert.deepEqual(Object.keys(models), ["gateway-model"]);
  assert.equal(models["gateway-model"].limit.context, 12000);
  assert.equal(models["gateway-model"].api.url, "https://gateway.example/v1");
  assert.deepEqual(fixture.calls.map(call => call.url), ["https://gateway.example/v1/models", "https://anyrouter.top/api/pricing"]);
  assert.equal(fixture.calls[0].init.headers.get("authorization"), "Bearer inference-secret");
  assert.equal(fixture.calls[0].init.headers.get("cookie"), null);
  assert.equal(fixture.calls[0].init.headers.get("new-api-user"), null);
  assert.equal(fixture.calls[1].init.headers.get("authorization"), null);
});
