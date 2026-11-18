import { errorEnvelope, errorOf } from "./protocols.mjs";
import { readBoundedText } from "./site-client.mjs";

const encoder = new TextEncoder();
const frame = (value, event = value.type) => (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(value)}\n\n`;

function heartbeat(protocol) {
  // These carry no response/item identity or model output. In particular,
  // Codex counts a parsed in_progress event as activity, but not an SSE comment.
  if (protocol === "responses") return frame({ type: "response.in_progress" });
  if (protocol === "anthropic") return frame({ type: "ping" });
  if (protocol === "chat") return frame({ id: "", object: "chat.completion.chunk", created: 0, model: "", choices: [] });
  return frame({});
}

function jsonStream(value, protocol) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid upstream JSON result.");
  const terminal = reason => typeof reason === "string" && reason.length > 0;
  if (protocol === "gemini" && ((!value.candidates?.length && value.promptFeedback?.blockReason) ||
      (value.candidates?.length && value.candidates.every(candidate => terminal(candidate.finishReason))))) return frame(value);
  if (protocol === "chat" && value.choices?.length && value.choices.every(choice => terminal(choice.finish_reason))) {
    return frame({ ...value, object: "chat.completion.chunk", choices: value.choices.map((choice, index) => {
      const delta = { ...choice.message };
      if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
      return { index: choice.index ?? index, delta, finish_reason: choice.finish_reason };
    }) }) + "data: [DONE]\n\n";
  }
  if (protocol === "anthropic" && Array.isArray(value.content) && terminal(value.stop_reason)) {
    return frame({ type: "message_start", message: { ...value, content: [], stop_reason: null, stop_sequence: null } }) +
      value.content.map((content_block, index) => frame({ type: "content_block_start", index, content_block }) + frame({ type: "content_block_stop", index })).join("") +
      frame({ type: "message_delta", delta: { stop_reason: value.stop_reason, stop_sequence: value.stop_sequence }, usage: value.usage }) + frame({ type: "message_stop" });
  }
  if (protocol === "responses" && Array.isArray(value.output) && ["completed", "incomplete"].includes(value.status)) {
    let sequence = 0;
    const event = (type, body) => frame({ type, sequence_number: sequence++, ...body });
    return event("response.created", { response: { ...value, status: "in_progress", output: [], usage: null } }) +
      value.output.map((item, output_index) => {
        const initial = { ...item, status: "in_progress" };
        if (Array.isArray(initial.content)) initial.content = [];
        if (typeof initial.arguments === "string") initial.arguments = "";
        if (initial.type === "custom_tool_call") initial.input = "";
        return event("response.output_item.added", { item: initial, output_index }) + event("response.output_item.done", { item, output_index });
      }).join("") + event(value.status === "incomplete" ? "response.incomplete" : "response.completed", { response: value });
  }
  throw new Error("The upstream returned an unsupported non-streaming result to a streaming request.");
}

function failedStream(error, status, protocol, headers) {
  const detail = { ...error, http_status: status };
  const hints = {};
  for (const key of ["retry-after", "retry-after-ms", "x-ms-retry-after-ms", "x-magpie-sign-in"]) {
    if (headers?.has(key)) hints[key] = headers.get(key);
  }
  if (Object.keys(hints).length) detail.headers = hints;
  const envelope = errorEnvelope(detail, status, protocol);
  if (protocol === "responses") return frame({ type: "response.failed", response: { status: "failed", error: envelope.error } });
  return frame(envelope, protocol === "gemini" ? undefined : "error");
}

// Delay committing HTTP 200 so ordinary/fast errors retain their HTTP status
// and routing headers. After commitment, all results (including errors) must
// remain SSE. Model output is still released only after the retry filter wins.
export async function deliverWithKeepalive(pending, { protocol, keepaliveMs, signal, cancel, maxBufferBytes, onStart }) {
  if (!keepaliveMs) return pending;
  const waiting = Symbol("waiting");
  let delay;
  const first = await Promise.race([pending, new Promise(resolve => { delay = setTimeout(() => resolve(waiting), keepaliveMs); })])
    .finally(() => clearTimeout(delay));
  if (first !== waiting) return first;
  if (signal.aborted) throw signal.reason;
  onStart?.();

  let stopped = false, reader, timer, controller;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    signal.removeEventListener("abort", abort);
  };
  const abort = () => {
    if (stopped) return;
    stop();
    cancel(signal.reason);
    reader?.cancel(signal.reason).catch(() => {});
    controller.error(signal.reason);
  };
  const ready = pending.then(async response => {
    if (stopped) { await response.body?.cancel(); return; }
    if (response.ok && /^text\/event-stream\b/i.test(response.headers.get("content-type") || "")) {
      reader = response.body?.getReader();
    } else {
      let value, text = "";
      try {
        text = await readBoundedText(response, response.ok ? maxBufferBytes : 65536);
        value = JSON.parse(text);
      } catch {}
      const error = errorOf(value);
      let result;
      if (!response.ok || error) result = failedStream(error || { code: "upstream_error", message: text.slice(0, 4096) || `Upstream HTTP ${response.status}` }, response.status, protocol, response.headers);
      else {
        try { result = jsonStream(value, protocol); }
        catch { result = failedStream({ code: "invalid_stream_response", message: "The upstream did not return a supported streaming result." }, 502, protocol); }
      }
      reader = new Response(result).body.getReader();
    }
    clearInterval(timer);
    if (stopped) await reader?.cancel();
  });
  // Attach a rejection handler immediately, including when nobody pulls the
  // downstream body. Cancellation must never leave a background retry running.
  ready.catch(error => { if (!stopped) { stop(); controller.error(error); } });
  const body = new ReadableStream({
    start(target) {
      controller = target;
      const tick = () => {
        if (!stopped && target.desiredSize > 0) target.enqueue(encoder.encode(heartbeat(protocol)));
      };
      tick();
      timer = setInterval(tick, keepaliveMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(target) {
      try {
        await ready;
        if (stopped) return;
        const part = await reader?.read();
        if (stopped) return;
        if (!part || part.done) { stop(); target.close(); }
        else target.enqueue(part.value);
      } catch (error) { if (!stopped) { stop(); target.error(error); } }
    },
    cancel(reason) {
      stop();
      cancel(reason || new DOMException("The downstream stream was canceled.", "AbortError"));
      return reader?.cancel(reason).catch(() => {});
    }
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}
