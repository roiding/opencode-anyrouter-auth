import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import test from "node:test";
import { _internal } from "../lib/responses-filter.mjs";

const { fetchWithFilter, defaultRetryDelay, cleanResponsesRequest } = _internal;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encrypted = { type: "invalid_request_error", code: "invalid_encrypted_content", message: "The encrypted content could not be verified." };
const azure = { type: "invalid_request_error", message: "The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it." };
const history = {
  model: "request-chosen-model", stream: true, store: true,
  reasoning: { effort: "xhigh" }, include: ["reasoning.encrypted_content"],
  input: [
    { type: "reasoning", id: "reasoning-old", encrypted_content: "sealed-private-history" },
    { type: "message", id: "message-old", role: "user", content: "private-user-text" },
    { type: "function_call", id: "call-old", call_id: "pair", name: "lookup", arguments: "{}" },
    { type: "function_call_output", id: "result-old", call_id: "pair", output: "ok" }
  ]
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers }
});
const frame = (event, value = {}) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const completed = frame("response.completed", { response: { output: [{ type: "reasoning", encrypted_content: "new-good-history" }] } });
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(steps, options = {}) {
  const calls = [], logs = [];
  const fetchImpl = async (url, init) => {
    const raw = typeof init.body === "string" ? init.body : decoder.decode(init.body);
    const call = { url, init, raw, body: JSON.parse(raw) };
    calls.push(call);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return step(call, calls.length);
  };
  return {
    calls, logs,
    send: (body = history, init = {}) => fetchWithFilter("https://relay.example/v1/responses", {
      method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init
    }, { fetchImpl, retryDelay: () => 0, onEvent: (event, data) => logs.push({ event, ...data }), ...options })
  };
}

test("ordinary retries preserve exact request bytes and its chosen model", async () => {
  const raw = "\n " + JSON.stringify(history, null, 2) + "\n";
  const h = harness([() => json({ error: { code: "rate_limit_exceeded" } }, 429), () => sse(completed)]);
  assert.match(await (await h.send(raw)).text(), /new-good-history/);
  assert.deepEqual(h.calls.map(call => call.raw), [raw, raw]);
  assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 0);
});

test("explicit HTTP transport failures retry on gateway statuses without cleaning history", async t => {
  for (const status of [408, 500, 502, 503, 504]) await t.test(String(status), async () => {
    const h = harness([() => json({ error: { code: "upstream_idle_timeout", message: "idle timeout waiting for SSE" } }, status), () => sse(completed)]);
    assert.match(await (await h.send()).text(), /new-good-history/);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls.map(call => call.body), [history, history]);
    assert.equal(h.logs.find(row => row.event === "http-error").kind, "transport");
  });
  for (const status of [400, 401, 403, 429]) await t.test(`no retry ${status}`, async () => {
    const h = harness([() => json({ error: { code: "upstream_idle_timeout", message: "idle timeout waiting for SSE" } }, status)]);
    assert.equal((await h.send()).status, status);
    assert.equal(h.calls.length, 1);
  });
});

test("buffered SSE returns headers and real non-content events while upstream is still working", { timeout: 3000 }, async t => {
  let upstream, beat;
  t.after(() => clearInterval(beat));
  const h = harness([() => new Response(new ReadableStream({ start(controller) {
    upstream = controller;
    controller.enqueue(encoder.encode(frame("response.output_item.added", { item: { id: "winning-tool", type: "function_call", arguments: "{}" } })));
    beat = setInterval(() => controller.enqueue(encoder.encode(": upstream is alive\n\n")), 20);
  } }), { headers: { "content-type": "text/event-stream" } })], { keepaliveMs: 10, idleTimeoutMs: 500 });
  const response = await h.send();
  assert.equal(h.logs.some(row => row.event === "request-finished"), false);
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  for (let i = 0; i < 3; i++) {
    const chunk = decoder.decode((await reader.read()).value);
    assert.match(chunk, /data:.*response.in_progress/);
    assert.doesNotMatch(chunk, /winning-tool|function_call|response.created/);
  }
  clearInterval(beat);
  upstream.enqueue(encoder.encode(completed));
  upstream.close();
  let text = "";
  while (true) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value); }
  assert.match(text, /winning-tool/);
  assert.match(text, /new-good-history/);
  assert.equal(h.calls.length, 1);
});

test("keepalive spans retry backoff but never releases failed attempt IDs, text or tools", { timeout: 3000 }, async () => {
  const h = harness([
    async () => { await delay(30); return sse(frame("response.created", { response: { id: "failed-attempt-id" } }) +
      frame("response.output_item.done", { item: { type: "function_call", arguments: "unsafe-tool-text" } }) + frame("response.failed", { response: { error: encrypted } })); },
    async () => { await delay(30); return sse(frame("response.created", { response: { id: "original-winning-id" } }) + completed); }
  ], { keepaliveMs: 5, retryDelay: () => 30 });
  const response = await h.send();
  const text = await response.text();
  assert.ok((text.match(/response.in_progress/g) || []).length >= 4);
  assert.doesNotMatch(text, /failed-attempt-id|unsafe-tool-text|invalid_encrypted_content/);
  assert.match(text, /original-winning-id/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 1);
});

test("downstream cancellation after keepalive aborts upstream and prevents background retries", { timeout: 3000 }, async () => {
  const h = harness([() => new Promise(() => {})], { keepaliveMs: 5, idleTimeoutMs: 1000 });
  const response = await h.send();
  const reader = response.body.getReader();
  assert.match(decoder.decode((await reader.read()).value), /response.in_progress/);
  await reader.cancel();
  await delay(25);
  assert.equal(h.calls[0].init.signal.aborted, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.logs.filter(row => row.event === "retry-scheduled").length, 0);
  assert.equal(h.logs.find(row => row.event === "request-finished").outcome, "canceled");
});

test("downstream keepalive does not reset the independent upstream idle timeout", { timeout: 3000 }, async () => {
  const h = harness([() => new Promise(() => {}), () => sse(completed)], { keepaliveMs: 5, idleTimeoutMs: 35 });
  const text = await (await h.send()).text();
  assert.match(text, /response.in_progress/);
  assert.match(text, /new-good-history/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.logs.find(row => row.event === "transport-error").code, "upstream_idle_timeout");
});

test("a deadline after SSE commitment is an in-band failure, never JSON or fake completion", { timeout: 3000 }, async () => {
  const h = harness([() => new Promise(() => {})], { keepaliveMs: 5, deadlineMs: 65, idleTimeoutMs: 1000 });
  const response = await h.send();
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /response.failed/);
  assert.match(text, /request_deadline/);
  assert.doesNotMatch(text, /response.completed/);
  assert.equal(h.calls.length, 1);
});

test("late HTTP failures preserve error code, original status and routing hints inside SSE", async () => {
  const h = harness([async () => { await delay(30); return json({ error: { code: "invalid_api_key", message: "fixture rejection" } }, 401,
    { "x-magpie-sign-in": "expired", "retry-after": "7" }); }], { keepaliveMs: 5 });
  const text = await (await h.send()).text();
  assert.match(text, /response.failed/);
  assert.match(text, /invalid_api_key/);
  assert.match(text, /"http_status":401/);
  assert.match(text, /"retry-after":"7"/);
  assert.match(text, /"x-magpie-sign-in":"expired"/);
  assert.equal(h.calls.length, 1);
});

test("a failed full Responses JSON result cannot become a successful late SSE completion", async () => {
  const h = harness([async () => { await delay(30); return json({ id: "failed-json-id", status: "failed", error: null,
    output: [{ type: "function_call", arguments: "failed-json-tool" }] }); }, () => sse(completed)], { keepaliveMs: 5 });
  const text = await (await h.send()).text();
  assert.doesNotMatch(text, /failed-json-id|failed-json-tool/);
  assert.match(text, /new-good-history/);
  assert.equal(h.calls.length, 2);
});

test("keepalive is optional and never changes non-streaming requests", async () => {
  const h = harness([async () => { await delay(30); return json({ error: { code: "invalid_api_key" } }, 401); }], { keepaliveMs: 5 });
  const response = await h.send({ ...history, stream: false });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "invalid_api_key");
  const disabled = harness([async () => { await delay(30); return sse(completed); }], { keepaliveMs: 0 });
  assert.equal(await (await disabled.send()).text(), completed);
});

test("HTTP history errors clean only once and reuse cleanup through other retries", async () => {
  const h = harness([
    () => json({ error: encrypted }, 400),
    () => json({ error: { code: "rate_limit_exceeded" } }, 429),
    () => json({ error: azure }, 400),
    () => sse(completed)
  ]);
  await (await h.send()).text();
  assert.deepEqual(h.calls[0].body, history);
  for (const call of h.calls.slice(1)) assert.deepEqual(call.body, cleanResponsesRequest(history).body);
  assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 1);
  assert.doesNotMatch(JSON.stringify(h.logs), /sealed-private-history|private-user-text|request-chosen-model/);
});

test("business and non-target HTTP errors never trigger cleanup or local retry", async t => {
  for (const [status, error] of [
    [400, { code: "invalid_request_error", message: "bad input" }],
    [401, { code: "invalid_api_key", message: "bad key" }],
    [429, { code: "insufficient_quota" }],
    [403, encrypted], [500, encrypted],
    [400, { ...encrypted, type: "authentication_error" }],
    [400, { ...encrypted, message: "Account quota exhausted" }]
  ]) await t.test(`${status}:${error.code}`, async () => {
    const h = harness([() => json({ error }, status, { "x-magpie-sign-in": "kept" })]);
    const response = await h.send();
    assert.equal(response.status, status);
    assert.equal(response.headers.get("x-magpie-sign-in"), "kept");
    assert.deepEqual(await response.json(), { error });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].body, history);
    assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 0);
  });
});

test("unsafe context is preserved initially and refused only if cleanup becomes necessary", async t => {
  for (const extra of [
    { previous_response_id: "old-response" }, { conversation: "old-conversation" },
    { context_management: [{ type: "compaction" }] },
    { input: [{ type: "compaction", encrypted_content: "compacted-context" }] },
    { input: [{ type: "item_reference", id: "old-item" }] }
  ]) await t.test(Object.keys(extra)[0], async () => {
    const body = { ...history, ...extra };
    const healthy = harness([() => sse(completed)]);
    await (await healthy.send(body)).text();
    assert.deepEqual(healthy.calls[0].body, body);
    const rejected = harness([() => json({ error: encrypted }, 400)]);
    const response = await rejected.send(body);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.code, /response_reference_not_portable|encrypted_compaction_disabled|encrypted_context_not_portable/);
    assert.equal(rejected.calls.length, 1);
    assert.equal(rejected.logs.filter(row => row.event === "history-cleanup").length, 0);
  });
});

test("cleanup preserves phase, images, custom calls and nested resource IDs", () => {
  const body = { ...history, input: [...history.input,
    { type: "message", id: "assistant-id", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "done", annotations: [{ file_id: "keep-nested" }] }] },
    { id: "image-message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "custom_tool_call", id: "custom-call", call_id: "custom-pair", name: "execute", input: "echo ok" },
    { type: "custom_tool_call_output", id: "custom-result", call_id: "custom-pair", output: "ok" }
  ] };
  const result = cleanResponsesRequest(body);
  assert.equal(result.removed, 1);
  assert.equal(result.removedItemIds, 7);
  assert.equal(result.body.input[3].phase, "final_answer");
  assert.equal(result.body.input[3].content[0].annotations[0].file_id, "keep-nested");
  assert.deepEqual(result.body.input[4].content, body.input[5].content);
  assert.equal(result.body.input[5].call_id, "custom-pair");
  assert.equal(body.input[0].id, "reasoning-old");
});

test("basic request validation and request-size limits happen before upstream I/O", async t => {
  for (const [body, code, options] of [
    ["not json", "invalid_request_json", {}], ["null", "invalid_request_json", {}],
    ["[]", "invalid_request_json", {}], [{ input: 1 }, "invalid_input", {}],
    [{ include: "reasoning.encrypted_content" }, "invalid_include", {}],
    [history, "request_too_large", { maxRequestBytes: 20 }]
  ]) await t.test(code, async () => {
    const h = harness([() => json({})], options);
    const response = await h.send(body);
    assert.equal((await response.json()).error.code, code);
    assert.equal(h.calls.length, 0);
  });
});

test("Request inputs honor init body, method and header overrides", async () => {
  let captured;
  const request = new Request("https://relay.example/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "old-model", input: "old-text" }), headers: { "x-overridden": "old" }
  });
  const response = await fetchWithFilter(request, {
    body: JSON.stringify({ model: "new-model", input: "new-text" }), headers: { "x-overridden": "new" }
  }, { fetchImpl: async (url, init) => { captured = { url, init }; return json({ ok: true }); } });
  await response.text();
  assert.deepEqual(JSON.parse(decoder.decode(captured.init.body)), { model: "new-model", input: "new-text" });
  assert.equal(captured.init.headers.get("x-overridden"), "new");
});

test("compaction, models, site requests and non-POST paths are exact passthrough", async () => {
  for (const [path, method] of [["/v1/responses/compact", "POST"], ["/v1/models", "GET"], ["/api/user/login", "POST"], ["/v1/responses", "GET"]]) {
    const init = { method, ...(method === "POST" ? { body: "not JSON, still passthrough" } : {}) };
    const expected = json({ ok: true });
    let captured;
    const response = await fetchWithFilter("https://relay.example" + path, init, {
      fetchImpl: (input, args) => { captured = { input, args }; return expected; }
    });
    assert.equal(response, expected);
    assert.equal(captured.args, init);
    assert.equal(captured.input, "https://relay.example" + path);
  }
});

test("SSE failure cannot expose client tools while the stream is still buffered", async () => {
  let streamController, canceled = false, calls = 0, resolved = false;
  const first = new ReadableStream({ start(controller) { streamController = controller; }, cancel() { canceled = true; } });
  const fetchImpl = async () => {
    calls++;
    return calls === 1 ? new Response(first, { headers: { "content-type": "text/event-stream" } }) : sse(completed);
  };
  const pending = fetchWithFilter("https://relay.example/v1/responses", { method: "POST", body: JSON.stringify(history) }, { fetchImpl, retryDelay: () => 0 });
  pending.then(() => { resolved = true; });
  streamController.enqueue(encoder.encode(frame("response.output_item.done", { item: { type: "custom_tool_call", call_id: "failed-client-tool" } })));
  await delay(5);
  assert.equal(resolved, false);
  streamController.enqueue(encoder.encode(frame("response.failed", { response: { error: encrypted } })));
  const text = await (await pending).text();
  assert.match(text, /new-good-history/);
  assert.doesNotMatch(text, /failed-client-tool|response.failed/);
  assert.equal(calls, 2);
  assert.equal(canceled, true);
});

test("fragmented UTF-8, CRLF and multi-line SSE data are preserved on success", async () => {
  const text = ': heartbeat\r\n\r\nevent: response.output_text.delta\r\ndata: {"delta":"\u4f60\u597d"}\r\n\r\n'
    + 'event: response.completed\r\ndata: {"response":\r\ndata: {"output":[]}}\r\n\r\n';
  const bytes = encoder.encode(text);
  const h = harness([() => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } })]);
  assert.equal(await (await h.send()).text(), text);
  assert.equal(h.calls.length, 1);
});

test("SSE authentication errors are terminal, keep sign-in headers and discard tool output", async () => {
  const error = { ...encrypted, type: "authentication_error" };
  const h = harness([() => new Response(
    frame("response.output_item.done", { item: { call_id: "bad-tool" } }) + frame("response.failed", { response: { error } }),
    { headers: { "content-type": "text/event-stream", "x-magpie-sign-in": "expired" } }
  )]);
  const response = await h.send();
  assert.equal(response.headers.get("x-magpie-sign-in"), "expired");
  const body = await response.text();
  assert.match(body, /authentication_error/);
  assert.doesNotMatch(body, /bad-tool/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 0);
});

test("a client-header rejection is not mistaken for an expired inference key", async () => {
  const error = { message: "unauthorized client detected" };
  const h = harness([() => json({ error }, 401)]);
  const response = await h.send();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept");
  assert.deepEqual(await response.json(), { error });
  assert.equal(h.calls.length, 1);
  const explicit = harness([() => json({ error: { ...error, code: "invalid_api_key" } }, 401)]);
  assert.equal((await explicit.send()).headers.get("x-magpie-sign-in"), null);
});

test("SSE size enforcement cancels before returning output and never retries", async () => {
  let canceled = false;
  const h = harness([() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(frame("response.output_item.done", { item: { call_id: "large-tool" } })));
  }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } })], { maxBufferBytes: 20 });
  const response = await h.send();
  assert.equal((await response.json()).error.code, "response_too_large");
  assert.equal(h.calls.length, 1);
  assert.equal(canceled, true);
});

test("incomplete terminal responses are delivered once, without replay", async () => {
  const text = frame("response.incomplete", { response: { output: [], incomplete_details: { reason: "max_output_tokens" } } });
  const h = harness([() => sse(text)]);
  assert.equal(await (await h.send()).text(), text);
  assert.equal(h.calls.length, 1);
});

test("interrupted SSE and empty failed details retry unchanged under the transport budget", async t => {
  for (const failed of [frame("response.output_text.delta", { delta: "failed-text" }), frame("response.failed", { response: { error: {} } })]) {
    await t.test(failed.includes("response.failed") ? "no details" : "interrupted", async () => {
      const h = harness([() => sse(failed), () => sse(completed)]);
      const text = await (await h.send()).text();
      assert.doesNotMatch(text, /failed-text|response.failed/);
      assert.deepEqual(h.calls.map(call => call.body), [history, history]);
      assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 0);
    });
  }
  const persistent = harness([() => sse(frame("response.failed", { response: {} }))]);
  assert.equal((await (await persistent.send()).json()).error.code, "upstream_failed_without_details");
  assert.equal(persistent.calls.length, 11);
});

test("persistent resource errors consume five retries, but only one cleanup", async () => {
  const h = harness([() => json({ error: azure }, 400)]);
  const response = await h.send();
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: azure });
  assert.equal(h.calls.length, 6);
  assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 1);
});

test("mixed retry classes cannot exceed the combined twenty-retry budget", async () => {
  const h = harness([(call, attempt) => {
    if (attempt <= 5) return json({ error: azure }, 400);
    if (attempt <= 15) throw new Error("transport disconnected");
    if (attempt <= 20) return json({ error: { code: "no_available_channel" } }, 503);
    return json({ error: { code: "rate_limit_exceeded" } }, 429);
  }]);
  assert.equal((await h.send()).status, 429);
  assert.equal(h.calls.length, 21);
  assert.equal(h.logs.filter(row => row.event === "retry-dispatched").length, 20);
  assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 1);
});

test("Retry-After is a lower bound, backoff plateaus, and rate retries add jitter", () => {
  assert.equal(defaultRetryDelay("resource", 0, new Headers(), 0), 1000);
  assert.equal(defaultRetryDelay("transport", 12, new Headers(), 0), 15000);
  assert.equal(defaultRetryDelay("rateLimit", 12, new Headers(), 0, () => 0.5), 60500);
  assert.equal(defaultRetryDelay("resource", 0, new Headers({ "retry-after": "10", "x-ms-retry-after-ms": "20000" }), 0), 20000);
  assert.equal(defaultRetryDelay("resource", 0, new Headers({ "retry-after": "Thu, 01 Jan 1970 00:01:00 GMT" }), 0), 60000);
});

test("insufficient deadline for server backoff returns the error without cleanup", async () => {
  const h = harness([() => json({ error: encrypted }, 400, { "retry-after": "20" })], {
    retryDelay: defaultRetryDelay, deadlineMs: 1000
  });
  assert.equal((await h.send()).status, 400);
  assert.equal(h.calls.length, 1);
  assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 0);
});

test("total deadline actively cancels stalled headers and stalled SSE readers", async t => {
  for (const mode of ["headers", "sse"]) await t.test(mode, async () => {
    let signal, canceled = false;
    const startedAt = Date.now();
    const response = await fetchWithFilter("https://relay.example/v1/responses", {
      method: "POST", body: JSON.stringify(history)
    }, { deadlineMs: 30, idleTimeoutMs: 1000, fetchImpl: async (url, init) => {
      signal = init.signal;
      if (mode === "headers") return new Promise(() => {});
      return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
    } });
    assert.equal((await response.json()).error.code, "request_deadline");
    assert.equal(signal.aborted, true);
    assert.ok(Date.now() - startedAt < 500);
    if (mode === "sse") assert.equal(canceled, true);
  });
});

test("idle timeout discards stalled output, retries once and preserves history", async () => {
  let canceled = false;
  const h = harness([() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(frame("response.output_text.delta", { delta: "stalled-text" })));
  }, cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } }), () => sse(completed)], {
    idleTimeoutMs: 15, deadlineMs: 2000
  });
  assert.doesNotMatch(await (await h.send()).text(), /stalled-text/);
  assert.deepEqual(h.calls.map(call => call.body), [history, history]);
  assert.equal(canceled, true);
});

test("canceling during cleanup backoff stops retries and reports cancellation", async () => {
  const controller = new AbortController();
  const logs = [];
  const h = harness([() => json({ error: encrypted }, 400)], {
    retryDelay: () => 100,
    onEvent: (event, data) => {
      logs.push({ event, ...data });
      if (event === "retry-scheduled") setTimeout(() => controller.abort(), 5);
    }
  });
  await assert.rejects(h.send(history, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(h.calls.length, 1);
  assert.equal(logs.at(-1).outcome, "canceled");
  assert.equal(logs.filter(row => row.event === "retry-dispatched").length, 0);
});

test("canceling while reading SSE does not create a retry or return failed output", async () => {
  const controller = new AbortController();
  let attempts = 0, canceled = false;
  const pending = fetchWithFilter("https://relay.example/v1/responses", {
    method: "POST", body: JSON.stringify(history), signal: controller.signal
  }, { fetchImpl: async () => {
    attempts++;
    setTimeout(() => controller.abort(), 5);
    return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
  } });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(attempts, 1);
  assert.equal(canceled, true);
});

test("client cancellation still interrupts an opaque passthrough body after headers", async () => {
  const controller = new AbortController(), logs = [];
  let canceled = false;
  const response = await fetchWithFilter("https://relay.example/v1/responses", {
    method: "POST", body: JSON.stringify(history), signal: controller.signal
  }, { onEvent: (event, data) => logs.push({ event, ...data }), fetchImpl: async () => new Response(
    new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/octet-stream" } }
  ) });
  const reading = response.text();
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(canceled, true);
  assert.equal(logs.at(-1).outcome, "canceled");
});

test("the total deadline also applies to a forwarded opaque body", async () => {
  let canceled = false;
  const response = await fetchWithFilter("https://relay.example/v1/responses", {
    method: "POST", body: JSON.stringify(history)
  }, { deadlineMs: 30, idleTimeoutMs: 1000, fetchImpl: async () => new Response(
    new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "application/octet-stream" } }
  ) });
  await assert.rejects(response.text(), { code: "request_deadline" });
  assert.equal(canceled, true);
});

test("oversized HTTP errors are forwarded intact without allocation-based classification", async () => {
  const text = "not-json:" + "x".repeat(80 * 1024);
  const h = harness([() => new Response(text, { status: 400, headers: { "x-upstream": "kept" } })]);
  const response = await h.send();
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("x-upstream"), "kept");
  assert.equal(await response.text(), text);
  assert.equal(h.calls.length, 1);
});

test("real fetch handles compressed HTTP and fragmented gzip SSE without double decoding", async t => {
  let calls = 0;
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    calls++;
    if (calls === 1) {
      res.writeHead(400, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(JSON.stringify({ error: encrypted })));
    } else {
      const bytes = zlib.gzipSync(completed);
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": String(bytes.length) });
      for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const response = await fetchWithFilter(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: "POST", body: JSON.stringify(history)
  }, { retryDelay: () => 0 });
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(await response.text(), completed);
  assert.deepEqual(bodies, [history, cleanResponsesRequest(history).body]);
});

test("a real upstream SSE connection is closed when the total deadline expires", async t => {
  let closed = false;
  const server = http.createServer((req, res) => {
    req.resume();
    res.on("close", () => { closed = true; });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame("response.output_item.done", { item: { call_id: "never-deliver" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const response = await fetchWithFilter(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: "POST", body: JSON.stringify(history)
  }, { deadlineMs: 100, idleTimeoutMs: 1000 });
  const error = await response.text();
  assert.match(error, /request_deadline/);
  assert.doesNotMatch(error, /never-deliver/);
  for (let i = 0; i < 100 && !closed; i++) await delay(2);
  assert.equal(closed, true);
});
