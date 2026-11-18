import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import module, { _internal } from "../generic.mjs";

const { cleanResponsesRequest, fetchWithFilter, historyErrorCode } = _internal;
const resourceError = {
  type: "invalid_request_error",
  message: "The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it."
};
const encryptedError = {
  type: "invalid_request_error",
  code: "invalid_encrypted_content",
  message: "The encrypted content could not be verified."
};

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
  }));
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

test("cleanup removes reasoning and portable IDs while preserving call pairs", () => {
  const body = {
    store: true,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high" },
    input: [
      { type: "reasoning", id: "rs", encrypted_content: "old-secret" },
      { type: "message", id: "msg", role: "user", content: "hello" },
      { type: "function_call", id: "fc", call_id: "pair", name: "tool", arguments: "{}" },
      { type: "function_call_output", id: "out", call_id: "pair", output: "ok" }
    ]
  };
  assert.deepEqual(cleanResponsesRequest(body), {
    removed: 1,
    removedItemIds: 3,
    body: {
      store: false,
      include: [],
      reasoning: { effort: "high" },
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "function_call", call_id: "pair", name: "tool", arguments: "{}" },
        { type: "function_call_output", call_id: "pair", output: "ok" }
      ]
    }
  });
});

test("module exports an OpenCode-compatible Magpie provider plugin", async () => {
  const hooks = await module.server({});
  const config = {};
  await hooks.config(config);

  assert.deepEqual(Object.keys(config.provider["auto-codex-filter"].models), []);
  assert.equal(config.provider["auto-codex-filter"].npm, "@ai-sdk/openai");
  assert.equal(hooks.auth.provider, "auto-codex-filter");
  assert.equal(hooks.auth.methods[0].type, "api");
  assert.equal(hooks.provider.id, "auto-codex-filter");
});

test("generic entry reads options from the host's second parameter", async () => {
  const hooks = await module.server({ client: {}, directory: "/sandbox" }, {
    providerId: "configured-filter",
    baseURL: "https://gateway.example/v1",
    models: ["request-model"],
    filter: { enabled: false }
  });
  const config = {};
  await hooks.config(config);
  assert.equal(hooks.auth.provider, "configured-filter");
  assert.equal(config.provider["configured-filter"].api, "https://gateway.example/v1");
  assert.deepEqual(Object.keys(config.provider["configured-filter"].models), ["request-model"]);
});

test("model catalog is discovered from the configured Responses endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, init) => {
    requested.push({ input: String(input), init });
    return new Response(JSON.stringify({ data: [{ id: "request-model-a" }, { id: "request-model-b" }] }), {
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const hooks = await module.server({}, { modelsRegistryPath: fileURLToPath(new URL("./fixtures/models.json", import.meta.url)) });
    await hooks.config({});
    const models = await hooks.provider.models({ models: {} }, {
      auth: { key: "test-key", metadata: { baseURL: "https://gateway.example/v1" } }
    });
    assert.equal(requested.length, 1);
    assert.equal(requested[0].input, "https://gateway.example/v1/models");
    assert.deepEqual(requested[0].init.headers, new Headers({ authorization: "Bearer test-key" }));
    assert.equal(requested[0].init.redirect, "error");
    assert.ok(requested[0].init.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(models), ["request-model-a", "request-model-b"]);
    assert.equal(models["request-model-a"].api.url, "https://gateway.example/v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generic metadata uses the same resolver, preserves aliases and never invents default limits", async () => {
  assert.equal(_internal.normalizeModels(["unknown"]).unknown.limit, undefined);
  assert.equal(_internal.normalizeModels(["unknown"]).unknown.reasoning, undefined);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-fixture-exact" }] });
  try {
    const hooks = await module.server({}, { baseURL: "https://gateway.example/v1",
      modelsRegistryPath: fileURLToPath(new URL("./fixtures/models.json", import.meta.url)),
      models: { friendly: { id: "gpt-fixture-exact", limit: { input: 70000 } } } });
    await hooks.config({});
    const models = await hooks.provider.models({ models: {} }, { auth: { key: "fixture-only" } });
    assert.deepEqual(Object.keys(models), ["friendly"]);
    assert.deepEqual(models.friendly.limit, { context: 100000, input: 70000, output: 10000 });
    assert.deepEqual(Object.keys(models.friendly.variants), ["none", "high"]);
    assert.equal(models.friendly.api.id, "gpt-fixture-exact");
    assert.equal(models.friendly.api.url, "https://gateway.example/v1");
  } finally { globalThis.fetch = originalFetch; }
});

test("only precise encrypted-resource errors trigger cleanup", () => {
  assert.equal(historyErrorCode({ error: resourceError }), "different_azure");
  assert.equal(historyErrorCode({ error: encryptedError }), "invalid_encrypted_content");
  assert.equal(historyErrorCode({ error: { ...encryptedError, type: "authentication_error" } }), null);
  assert.equal(historyErrorCode({ error: { ...encryptedError, message: "quota exhausted" } }), null);
});

test("first request is preserved, target HTTP error cleans once, and next request resets", async t => {
  const bodies = [];
  const history = {
    store: true,
    include: ["reasoning.encrypted_content"],
    input: [{ type: "reasoning", id: "rs" }, { type: "message", id: "msg", role: "user", content: "hi" }]
  };
  const { server, origin } = await listen(async (req, res) => {
    bodies.push(await readBody(req));
    if (bodies.length === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: resourceError }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });
  t.after(() => close(server));
  const first = await fetchWithFilter(origin + "/v1/responses", {
    method: "POST",
    body: JSON.stringify(history)
  }, { retryDelay: () => 0 });
  await first.text();
  const second = await fetchWithFilter(origin + "/v1/responses", {
    method: "POST",
    body: JSON.stringify(history)
  }, { retryDelay: () => 0 });
  await second.text();

  assert.deepEqual(bodies[0], history);
  assert.equal(bodies[1].store, false);
  assert.deepEqual(bodies[1].include, []);
  assert.deepEqual(bodies[1].input, [{ type: "message", role: "user", content: "hi" }]);
  assert.deepEqual(bodies[2], history);
});

test("failed SSE tool output is discarded before retry and successful output is returned", async t => {
  const bodies = [];
  const history = { stream: true, input: [{ type: "message", id: "msg", role: "user", content: "hi" }] };
  const { server, origin } = await listen(async (req, res) => {
    bodies.push(await readBody(req));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (bodies.length === 1) {
      res.end("event: response.output_item.done\ndata: " +
        JSON.stringify({ item: { type: "custom_tool_call", call_id: "bad" } }) +
        "\n\nevent: response.failed\ndata: " +
        JSON.stringify({ response: { error: encryptedError } }) + "\n\n");
    } else {
      res.end("event: response.completed\ndata: " +
        JSON.stringify({ response: { output: [{ type: "reasoning", encrypted_content: "new-good" }] }}) +
        "\n\n");
    }
  });
  t.after(() => close(server));
  const response = await fetchWithFilter(origin + "/v1/responses", {
    method: "POST",
    body: JSON.stringify(history)
  }, { retryDelay: () => 0 });
  const body = await response.text();

  assert.match(body, /new-good/);
  assert.doesNotMatch(body, /bad|response.failed/);
  assert.equal(bodies[1].input[0].id, undefined);
});

test("unsafe server references are rejected instead of silently discarded", async t => {
  let attempts = 0;
  const { server, origin } = await listen(async (req, res) => {
    attempts++;
    await readBody(req);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: encryptedError }));
  });
  t.after(() => close(server));
  const response = await fetchWithFilter(origin + "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ previous_response_id: "old", input: "hi" })
  }, { retryDelay: () => 0 });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "response_reference_not_portable");
  assert.equal(attempts, 1);
});
