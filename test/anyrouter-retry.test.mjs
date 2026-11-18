import assert from "node:assert/strict";
import test from "node:test";
import { _internal } from "../lib/responses-filter.mjs";

const { createFilteredFetch, normalizeFilterOptions, retryErrorClass, RETRY_PROFILES } = _internal;
const encoder = new TextEncoder();
const frame = (event, value = {}) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const success = frame("response.completed", { response: { status: "completed", output: [] } });
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

function send(steps, options = {}) {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body) });
    return steps[Math.min(calls.length - 1, steps.length - 1)]();
  };
  const filtered = createFilteredFetch(fetchImpl, {
    retryProfile: "anyrouter",
    retryDelay: () => 0,
    onEvent: (event, data) => logs.push({ event, ...data }),
    ...options
  });
  return {
    calls,
    logs,
    async run() {
      const response = await filtered("https://relay.example/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "chosen", input: "hello" })
      });
      return { response, text: await response.text() };
    }
  };
}

test("AnyRouter retry profile is explicit, conservative and validates names", () => {
  assert.equal(normalizeFilterOptions({ retryProfile: "anyrouter" }).retryProfile, "anyrouter");
  assert.equal(RETRY_PROFILES.anyrouter.maxRetries, 8);
  assert.deepEqual(RETRY_PROFILES.anyrouter.limits, {
    resource: 1,
    rateLimit: 3,
    transport: 4,
    availability: 2
  });
  assert.throws(() => normalizeFilterOptions({ retryProfile: "unknown" }), /retryProfile/);
});

test("AnyRouter messages are classified without retrying credentials, quota or model errors", () => {
  assert.equal(retryErrorClass({ error: { message: "请求次数过多，请稍后再试" } }), "rateLimit");
  assert.equal(retryErrorClass({ error: { message: "Too many requests" } }), "rateLimit");
  assert.equal(retryErrorClass({ error: { message: "当前分组上游负载已饱和" } }), "availability");
  assert.equal(retryErrorClass({ error: { message: "当前分组 default 下对于模型 gpt-x 无可用渠道" } }), "availability");
  assert.equal(retryErrorClass({ error: { message: "stream disconnected before completion" } }), "transport");
  assert.equal(retryErrorClass({ error: { message: "idle timeout waiting for SSE" } }), "transport");
  for (const error of [
    { code: "insufficient_quota", message: "余额不足" },
    { code: "invalid_api_key", message: "无效的令牌" },
    { code: "model_not_found", message: "模型不存在" },
    { code: "invalid_request_error", message: "上下文长度超过限制" }
  ]) {
    assert.equal(retryErrorClass({ error }), null);
  }
});

test("AnyRouter rate and availability failures retry only within the small budget", async t => {
  await t.test("rate limit succeeds", async () => {
    const h = send([
      () => json({ error: { message: "请求次数过多，请稍后再试" } }, 429),
      () => sse(success)
    ]);
    const result = await h.run();
    assert.equal(result.text, success);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls.map(call => call.body), [
      JSON.stringify({ model: "chosen", input: "hello" }),
      JSON.stringify({ model: "chosen", input: "hello" })
    ]);
    assert.equal(h.logs.find(row => row.event === "request-started").maxRetries, 8);
  });

  await t.test("availability succeeds", async () => {
    const h = send([
      () => json({ error: { message: "当前分组上游负载已饱和" } }, 503),
      () => sse(success)
    ]);
    const result = await h.run();
    assert.equal(result.text, success);
    assert.equal(h.calls.length, 2);
  });

  await t.test("persistent rate limit stops after three retries", async () => {
    const h = send([
      () => json({ error: { message: "请求次数过多" } }, 429)
    ]);
    const result = await h.run();
    assert.equal(h.calls.length, 4);
    assert.equal(result.response.status, 429);
  });

  await t.test("persistent availability stops after two retries", async () => {
    const h = send([
      () => json({ error: { message: "无可用渠道" } }, 503)
    ]);
    const result = await h.run();
    assert.equal(h.calls.length, 3);
    assert.equal(result.response.status, 503);
  });

  await t.test("bare 429 is a rate-limit retry", async () => {
    const h = send([
      () => new Response("", { status: 429 }),
      () => sse(success)
    ]);
    const result = await h.run();
    assert.equal(result.text, success);
    assert.equal(h.calls.length, 2);
  });

  await t.test("bare 503 and 504 are availability retries", async () => {
    for (const status of [503, 504]) {
      const h = send([
        () => new Response("", { status }),
        () => sse(success)
      ]);
      const result = await h.run();
      assert.equal(result.text, success);
      assert.equal(h.calls.length, 2);
    }
  });
});

test("AnyRouter authentication, quota and model errors never retry", async t => {
  for (const [status, error] of [
    [401, { code: "invalid_api_key", message: "无效的令牌" }],
    [403, { code: "permission_denied", message: "无权进行此操作" }],
    [429, { code: "insufficient_quota", message: "余额不足" }],
    [404, { code: "model_not_found", message: "模型不存在" }]
  ]) {
    await t.test(`${status}:${error.code}`, async () => {
      const h = send([() => json({ error }, status)]);
      const result = await h.run();
      assert.equal(h.calls.length, 1);
      assert.equal(result.response.status, status);
    });
  }
});

test("AnyRouter overload in a buffered SSE error is retried and failed output is withheld", async () => {
  const failed = frame("response.failed", {
    response: { error: { code: "server_error", message: "上游繁忙，请稍后再试" } }
  });
  const h = send([
    () => sse(frame("response.output_text.delta", { delta: "must-not-leak" }) + failed),
    () => sse(success)
  ]);
  const result = await h.run();
  assert.equal(result.text, success);
  assert.doesNotMatch(result.text, /must-not-leak/);
  assert.equal(h.calls.length, 2);
});
