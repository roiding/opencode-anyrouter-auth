import assert from "node:assert/strict";
import test from "node:test";
import { deliverWithKeepalive } from "../lib/sse-delivery.mjs";
import { createSseInspector } from "../lib/protocols.mjs";

for (const [protocol, value, terminal] of [
  ["responses", { id: "resp_original", status: "completed", output: [{ type: "function_call", id: "item_original", call_id: "pair", name: "tool", arguments: "{}" }] }, "response.completed"],
  ["chat", { id: "chat_original", choices: [{ index: 0, message: { role: "assistant", content: "good" }, finish_reason: "stop" }] }, "complete"],
  ["anthropic", { id: "message_original", content: [{ type: "text", text: "good" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 1 } }, "complete"],
  ["gemini", { candidates: [{ index: 0, content: { parts: [{ text: "good" }] }, finishReason: "STOP" }] }, "complete"]
]) test(`late ${protocol} JSON success stays valid SSE after keepalive`, { timeout: 3000 }, async () => {
  let resolve;
  const pending = new Promise(yes => { resolve = yes; });
  const response = await deliverWithKeepalive(pending, { protocol, keepaliveMs: 5, maxBufferBytes: 65536,
    signal: new AbortController().signal, cancel() {} });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.doesNotMatch(first, /original|function_call|"good"/);
  resolve(Response.json(value));
  let text = first;
  while (true) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); }
  const inspector = createSseInspector(protocol);
  let result;
  for (const frame of text.split("\n\n").filter(Boolean)) result = inspector.accept(frame) || result;
  assert.equal((result || inspector.finish()).kind, terminal);
  if (protocol === "responses") {
    assert.match(text, /resp_original/);
    assert.match(text, /item_original/);
    assert.match(text, /"call_id":"pair"/);
  } else assert.match(text, /good/);
});

test("keepalive queue respects downstream backpressure", { timeout: 3000 }, async () => {
  let resolve;
  const response = await deliverWithKeepalive(new Promise(yes => { resolve = yes; }), {
    protocol: "responses", keepaliveMs: 2, maxBufferBytes: 1024, signal: new AbortController().signal, cancel() {}
  });
  await new Promise(yes => setTimeout(yes, 40));
  resolve(new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } }));
  await new Promise(yes => setTimeout(yes, 10));
  const text = await response.text();
  assert.equal((text.match(/event: response.in_progress/g) || []).length, 1);
});

test("nonterminal JSON results never become fake protocol completions", { timeout: 3000 }, async t => {
  for (const [protocol, value] of [
    ["responses", { status: "in_progress", output: [] }],
    ["chat", { choices: [{ index: 0, finish_reason: null }] }],
    ["anthropic", { content: [], stop_reason: null }],
    ["gemini", { candidates: [{ index: 0 }] }]
  ]) await t.test(protocol, async () => {
    let resolve;
    const response = await deliverWithKeepalive(new Promise(yes => { resolve = yes; }), {
      protocol, keepaliveMs: 2, maxBufferBytes: 1024, signal: new AbortController().signal, cancel() {}
    });
    resolve(Response.json(value));
    const text = await response.text();
    assert.doesNotMatch(text, /response.completed|message_stop|\[DONE\]/);
    assert.match(text, /invalid_stream_response|supported streaming result/);
  });
});
