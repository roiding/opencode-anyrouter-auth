import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithFilter, historyErrorCode } from "../lib/responses-filter.mjs";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const frame = (value, event = "") => (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(value)}\n\n`;
const sse = text => new Response(text, { headers: { "content-type": "text/event-stream" } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const rate = { code: "rate_limit_exceeded", message: "Token rate limit exceeded." };
const cases = {
  responses: {
    path: "/v1/responses", body: { model: "chosen", input: [{ type: "reasoning", id: "opaque-id", encrypted_content: "opaque-history" }, { role: "user", content: "hello" }], stream: true },
    prefix: frame({ delta: "failed-client-tool" }, "response.output_text.delta"),
    end: frame({ response: { status: "completed", output: [{ text: "good" }] } }, "response.completed"),
    error: frame({ response: { error: rate } }, "response.failed"),
    success: { status: "completed", output: [{ type: "message", content: [{ text: "good" }] }] }
  },
  chat: {
    path: "/v1/chat/completions", body: { model: "chosen", messages: [{ role: "assistant", reasoning_content: "keep-this", content: "hello" }], stream: true },
    prefix: frame({ choices: [{ index: 0, delta: { tool_calls: [{ id: "failed-client-tool" }] }, finish_reason: null }] }),
    end: frame({ choices: [{ index: 0, delta: { content: "good" }, finish_reason: "stop" }] }) + frame({ choices: [], usage: { total_tokens: 4 } }) + "data: [DONE]\n\n",
    error: frame({ error: rate }), success: { choices: [{ index: 0, message: { role: "assistant", content: "good" }, finish_reason: "stop" }] }
  },
  anthropic: {
    path: "/v1/messages", body: { model: "chosen", messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "opaque-history", signature: "must-keep" }, { type: "text", text: "hello" }] }], stream: true },
    prefix: frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "failed-client-tool", name: "lookup", input: {} } }, "content_block_start"),
    end: frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "good" } }, "content_block_delta") + frame({ type: "message_stop" }, "message_stop"),
    error: frame({ type: "error", error: { type: "overloaded_error", message: "Busy" } }, "error"),
    success: { type: "message", content: [{ type: "text", text: "good" }], stop_reason: "end_turn" }
  },
  gemini: {
    path: "/v1beta/models/chosen:streamGenerateContent?alt=sse", body: { contents: [{ role: "model", parts: [{ text: "hello", thoughtSignature: "must-keep" }] }] },
    prefix: frame({ candidates: [{ index: 0, content: { parts: [{ functionCall: { name: "failed-client-tool", args: {} } }] } }] }),
    end: frame({ candidates: [{ index: 0, content: { parts: [{ text: "good" }] }, finishReason: "STOP" }] }) + frame({ usageMetadata: { totalTokenCount: 4 } }),
    error: frame({ error: { code: 503, status: "UNAVAILABLE", message: "Busy" } }),
    success: { candidates: [{ index: 0, content: { parts: [{ text: "good" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 4 } }
  }
};

function harness(protocol, steps, options = {}) {
  const spec = cases[protocol], calls = [], logs = [];
  const send = (body = spec.body, init = {}) => fetchWithFilter("https://relay.example" + spec.path, {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init
  }, { retryDelay: () => 0, onEvent: (event, data) => logs.push({ event, ...data }), ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, raw: typeof init.body === "string" ? init.body : decoder.decode(init.body) });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      return step();
    }
  });
  return { send, calls, logs };
}

for (const [protocol, spec] of Object.entries(cases)) {
  test(`${protocol}: preserves initial bytes and retries in-stream transient errors without leaking tools`, async () => {
    const raw = "\n " + JSON.stringify(spec.body, null, 2) + "\n";
    const h = harness(protocol, [() => sse(spec.prefix + spec.error), () => sse(spec.end)]);
    const response = await h.send(raw);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), spec.end);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(call => call.raw === raw));
    assert.equal(h.logs.filter(row => row.event === "history-cleanup").length, 0);
  });

  test(`${protocol}: non-streaming HTTP 200 error envelopes are classified before delivery`, async () => {
    const h = harness(protocol, [() => json({ error: rate }), () => json(spec.success)]);
    const body = { ...spec.body, stream: false };
    assert.deepEqual(await (await h.send(body)).json(), spec.success);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(call => call.raw === JSON.stringify(body)));
  });

  test(`${protocol}: authentication, quota and signature errors are not retried or cleaned`, async t => {
    for (const error of [
      { type: "authentication_error", code: "invalid_api_key", message: "Invalid credential." },
      { code: "insufficient_quota", message: "Account balance exhausted." },
      { type: "invalid_request_error", code: "invalid_thinking_signature", message: "The signature cannot be verified." }
    ]) await t.test(error.code, async () => {
      const failedFrame = protocol === "responses" ? frame({ response: { error } }, "response.failed") : frame({ error }, protocol === "anthropic" ? "error" : "");
      const h = harness(protocol, [() => sse(spec.prefix + failedFrame)]);
      const result = await h.send();
      const text = await result.text();
      assert.ok(result.status >= 400);
      assert.doesNotMatch(text, /failed-client-tool|opaque-history|must-keep/);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].raw, JSON.stringify(spec.body));
      if (protocol === "anthropic") assert.equal(JSON.parse(text).type, "error");
      if (protocol === "gemini") assert.equal(JSON.parse(text).error.code, result.status);
    });
  });

  test(`${protocol}: an incomplete stream is discarded and retried without altering history`, async () => {
    const h = harness(protocol, [() => sse(spec.prefix), () => sse(spec.end)]);
    assert.equal(await (await h.send()).text(), spec.end);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(call => call.raw === JSON.stringify(spec.body)));
  });

  test(`${protocol}: fragmented UTF-8 and CRLF streams remain byte-exact`, async () => {
    const text = ": \u4f60\u597d\n\n" + spec.end;
    const crlf = text.replaceAll("\n", "\r\n");
    const bytes = encoder.encode(crlf);
    const h = harness(protocol, [() => new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } })]);
    assert.equal(await (await h.send()).text(), crlf);
    assert.equal(h.calls.length, 1);
  });

  test(`${protocol}: cancellation while buffering JSON cancels upstream without retry`, async () => {
    const controller = new AbortController();
    let canceled = false;
    const h = harness(protocol, [() => new Response(new ReadableStream({ start(stream) {
      stream.enqueue(encoder.encode('{"partial":"never-deliver"'));
      setTimeout(() => controller.abort(), 5);
    }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } })]);
    await assert.rejects(h.send(undefined, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(canceled, true);
    assert.equal(h.calls.length, 1);
  });
}

test("Chat DONE alone and Gemini EOF alone are not proofs of completion", async () => {
  for (const [protocol, text] of [["chat", "data: [DONE]\n\n"], ["gemini", frame({ usageMetadata: { totalTokenCount: 4 } })]]) {
    const h = harness(protocol, [() => sse(text), () => sse(cases[protocol].end)]);
    assert.equal(await (await h.send()).text(), cases[protocol].end);
    assert.equal(h.calls.length, 2);
  }
});

test("all requested Chat choices must terminate before DONE", async () => {
  const two = frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }, { index: 1, delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n\n";
  const h = harness("chat", [() => sse(cases.chat.end), () => sse(two)]);
  assert.equal(await (await h.send({ ...cases.chat.body, n: 2 })).text(), two);
  assert.equal(h.calls.length, 2);
});

test("Gemini prompt blocking is a legitimate terminal result, not a retry", async () => {
  const text = frame({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 5 } });
  const h = harness("gemini", [() => sse(text)]);
  assert.equal(await (await h.send()).text(), text);
  assert.equal(h.calls.length, 1);
});

test("Gemini waits for usage trailers and transport completion even after finishReason", async () => {
  let stream, resolved = false;
  const response = new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } });
  const h = harness("gemini", [() => response]);
  const pending = h.send();
  pending.then(() => { resolved = true; });
  stream.enqueue(encoder.encode(frame({ candidates: [{ index: 0, finishReason: "STOP" }] })));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(resolved, false);
  stream.enqueue(encoder.encode(frame({ usageMetadata: { totalTokenCount: 99 } })));
  stream.close();
  assert.match(await (await pending).text(), /totalTokenCount/);
});

test("terminal protocol markers do not leak bytes following them in the same chunk", async () => {
  for (const protocol of ["responses", "chat", "anthropic"]) {
    const h = harness(protocol, [() => sse(": \u4f60\u597d\n\n" + cases[protocol].end + "data: leaked-after-terminal\n\n")]);
    assert.equal(await (await h.send()).text(), ": \u4f60\u597d\n\n" + cases[protocol].end);
  }
});

test("Gemini per-minute resource exhaustion retries, but a daily or billing quota does not", async () => {
  for (const [message, attempts] of [["Requests per minute exceeded", 2], ["Daily quota exceeded", 1], ["Billing balance exhausted", 1]]) {
    const h = harness("gemini", [() => json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message } }, 429), () => json(cases.gemini.success)]);
    await (await h.send()).text();
    assert.equal(h.calls.length, attempts);
  }
});

test("Responses history repair also applies to a precise non-streaming HTTP 200 error", async () => {
  const error = { code: "invalid_encrypted_content", type: "invalid_request_error", message: "The encrypted history could not be verified." };
  const h = harness("responses", [() => json({ error }), () => json(cases.responses.success)]);
  await (await h.send()).text();
  assert.equal(h.calls.length, 2);
  assert.equal(JSON.parse(h.calls[1].raw).input.some(item => item.type === "reasoning"), false);
  for (const protocol of ["chat", "anthropic", "gemini"]) assert.equal(historyErrorCode({ error }, protocol), null);
});

test("compressed or binary request bodies and non-inference operations pass through unchanged", async () => {
  for (const [path, headers, method] of [
    ["/v1/messages", { "content-encoding": "gzip" }, "POST"],
    ["/v1/responses", { "content-type": "application/octet-stream" }, "POST"],
    ["/v1/files", {}, "POST"], ["/api/user/login", {}, "POST"], ["/v1/files/123", {}, "DELETE"]
  ]) {
    const init = { method, headers, body: new Uint8Array([0, 255, 12]) };
    const expected = json({ ok: true });
    const response = await fetchWithFilter("https://relay.example" + path, init, { fetchImpl: (url, actual) => { assert.equal(actual, init); return expected; } });
    assert.equal(response, expected);
  }
});

test("JSON response buffer overflows cancel without delivering a partial body or retrying", async () => {
  let canceled = false;
  const h = harness("chat", [() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('{"message":"never-deliver"}'));
  }, cancel() { canceled = true; } }), { headers: { "content-type": "application/json" } })], { maxBufferBytes: 8 });
  const response = await h.send();
  assert.equal((await response.json()).error.code, "response_too_large");
  assert.equal(h.calls.length, 1);
  assert.equal(canceled, true);
});
