import { createSseInspector, errorEnvelope, errorOf, errorRoutingHeaders, failureStatus, protocolOfURL, protocolRetryClass } from "./protocols.mjs";
import { deliverWithKeepalive } from "./sse-delivery.mjs";

const RESPONSE_LIMIT = 64 * 1024 * 1024;
const ERROR_LIMIT = 64 * 1024;
const RETRY_PROFILES = Object.freeze({
  default: {
    maxRetries: 20,
    limits: { resource: 5, rateLimit: 20, transport: 10, availability: 10 },
    delays: {
      resource: [1000, 2000, 4000, 8000, 15000],
      rateLimit: [10000, 20000, 40000, 60000, 60000],
      transport: [1000, 2000, 4000, 8000, 15000],
      availability: [5000, 10000, 20000, 30000, 60000]
    }
  },
  anyrouter: {
    // AnyRouter is frequently congested. Keep retries useful but bounded so a
    // single selected-provider call cannot hammer the shared upstream.
    maxRetries: 8,
    limits: { resource: 1, rateLimit: 3, transport: 4, availability: 2 },
    delays: {
      resource: [1000],
      rateLimit: [2000, 5000, 10000],
      transport: [1000, 2000, 4000, 8000],
      availability: [5000, 15000]
    }
  }
});
const MAX_RETRIES = RETRY_PROFILES.default.maxRetries;
const RETRY_LIMITS = RETRY_PROFILES.default.limits;
const RETRY_DELAYS = RETRY_PROFILES.default.delays;
const PORTABLE_ITEMS = new Set([
  "message",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output"
]);

class FilterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function cleanResponsesRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FilterError("invalid_request_json", "Responses request must be a JSON object.");
  }
  if (body.include !== undefined && !Array.isArray(body.include)) {
    throw new FilterError("invalid_include", "include must be an array.");
  }
  if (body.input !== undefined && typeof body.input !== "string" && !Array.isArray(body.input)) {
    throw new FilterError("invalid_input", "input must be a string or an array.");
  }
  if (body.previous_response_id || body.conversation) {
    throw new FilterError(
      "response_reference_not_portable",
      "Complete message/tool history is required, not previous_response_id or conversation references. Start a new session with a text summary."
    );
  }
  if (Array.isArray(body.context_management) &&
      body.context_management.some(item => item?.type === "compaction")) {
    throw new FilterError(
      "encrypted_compaction_disabled",
      "Encrypted compaction is disabled by this filter. Use a text summary and start a new session."
    );
  }

  const clean = { ...body, store: false };
  let removed = 0;
  let removedItemIds = 0;
  if (body.include) {
    clean.include = body.include.filter(value => value !== "reasoning.encrypted_content");
  }
  if (Array.isArray(body.input)) {
    clean.input = body.input.filter(item => {
      if (item?.type === "reasoning") {
        removed++;
        return false;
      }
      return true;
    });
    clean.input = clean.input.map(item => {
      if (item?.type === "compaction" || item?.type === "item_reference" || item?.encrypted_content) {
        throw new FilterError(
          "encrypted_context_not_portable",
          "Encrypted compaction/context references cannot safely cross accounts. Start a new session with a text summary; history has NOT been silently discarded."
        );
      }
      const isMessage = item && item.type === undefined &&
        typeof item.role === "string" && item.content !== undefined;
      if (item && (PORTABLE_ITEMS.has(item.type) || isMessage) && Object.hasOwn(item, "id")) {
        const portable = { ...item };
        delete portable.id;
        removedItemIds++;
        return portable;
      }
      return item;
    });
  }
  return { body: clean, removed, removedItemIds };
}

function retryErrorClass(value, protocol = "responses") {
  const reported = value?.error || value?.response?.error;
  if (value?.type === "response.failed" && (!reported ||
      (typeof reported === "object" && !reported.code && !reported.type && !reported.message))) {
    return "transport";
  }
  const error = value?.error || value?.response?.error || value;
  if (!error || typeof error !== "object") return null;
  const message = typeof error.message === "string" ? error.message : "";
  const code = String(error.code || error.type || "");
  const protocolKind = protocolRetryClass(value, protocol);
  if (protocolKind === "rateLimit" && !/billing|budget|balance|credit|daily|per.day/i.test(code + " " + message)) return protocolKind;
  if (/quota|budget|billing|balance|credit|spend.limit/i.test(code + " " + error.type + " " + message)) {
    return null;
  }
  if ([error.code, error.type, error.status].some(value =>
    /^(invalid_api_key|authentication_error|permission_error|permission_denied|unauthorized|forbidden|UNAUTHENTICATED|PERMISSION_DENIED)$/.test(value))) {
    return null;
  }
  if (protocol === "responses" && (error.type === "invalid_request_error" || value?.type === "error" || value?.type === "response.failed") &&
      message.includes("The requested item was created under a different Azure OpenAI resource.") &&
      message.includes("Use the same resource that created the item to access it.")) {
    return "resource";
  }
  if (/^(rate_limit_exceeded|rate_limit_error|too_many_requests)$/.test(code) ||
      /exceeded token rate limit/i.test(message) ||
      (/rate limit exceeded/i.test(message) && /your requests|token|requests per minute/i.test(message)) ||
      /请求次数过多|请求过多|too many requests|rate.?limit|限流/i.test(message)) {
    return "rateLimit";
  }
  if (/^(stream_incomplete|stream_disconnected|upstream_idle_timeout|upstream_aborted)$/.test(code) ||
      /stream closed before response\.completed|idle timeout waiting for SSE|stream disconnected before completion|unexpected eof|connection reset|fetch failed|network error|socket hang up|empty reply|upstream.*timeout/i.test(message)) {
    return "transport";
  }
  if (code === "no_available_channel" ||
      /无可用渠道|没有可用渠道|no available channels?|当前分组.*无可用|渠道.*不可用|负载已饱和|负载已满|系统繁忙|繁忙|overloaded|server busy|upstream unavailable|service unavailable/i.test(message)) {
    return "availability";
  }
  return protocolKind;
}

function historyErrorCode(value, protocol = "responses") {
  if (protocol !== "responses") return null;
  const error = value?.error || value?.response?.error || value;
  if (!error || typeof error !== "object") return null;
  if (/quota|budget|billing|balance|credit|spend.limit/i.test(
    [error.code, error.type, error.message].join(" "))) return null;
  if ([error.code, error.type].some(code =>
    /^(invalid_api_key|authentication_error|permission_denied|unauthorized|forbidden)$/.test(code))) return null;
  if (retryErrorClass(value) === "resource") return "different_azure";
  return error?.code === "invalid_encrypted_content" ? "invalid_encrypted_content" : null;
}

function isAlbBadRequestPage(text) {
  return typeof text === "string" && /<html\b[^>]*>/i.test(text) && /<\/html>/i.test(text) &&
    /<title>\s*400\s+Bad\s+Request\s*<\/title>/i.test(text) &&
    /<h1>\s*400\s+Bad\s+Request\s*<\/h1>/i.test(text) &&
    /<center>\s*alb\s*<\/center>/i.test(text);
}

function validateResponsesRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FilterError("invalid_request_json", "Responses request must be a JSON object.");
  }
  if (body.include !== undefined && !Array.isArray(body.include)) {
    throw new FilterError("invalid_include", "include must be an array.");
  }
  if (body.input !== undefined && typeof body.input !== "string" && !Array.isArray(body.input)) {
    throw new FilterError("invalid_input", "input must be a string or an array.");
  }
}

function normalizeFilterOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("filter options must be an object");
  }
  const result = {
    enabled: options.enabled ?? true,
    retryProfile: options.retryProfile ?? "default",
    deadlineMs: options.deadlineMs ?? 1800000,
    idleTimeoutMs: options.idleTimeoutMs ?? 120000,
    keepaliveMs: options.keepaliveMs ?? 10000,
    maxBufferBytes: options.maxBufferBytes ?? options.limit ?? RESPONSE_LIMIT,
    maxRequestBytes: options.maxRequestBytes ?? RESPONSE_LIMIT
  };
  if (typeof result.enabled !== "boolean") throw new Error("filter.enabled must be a boolean");
  if (typeof result.retryProfile !== "string" || !Object.hasOwn(RETRY_PROFILES, result.retryProfile)) {
    throw new Error("filter.retryProfile must be a known retry profile");
  }
  if (!Number.isInteger(result.keepaliveMs) || result.keepaliveMs < 0 || result.keepaliveMs > 60000) {
    throw new Error("filter.keepaliveMs must be an integer between 0 and 60000");
  }
  for (const key of ["deadlineMs", "idleTimeoutMs"]) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 1800000) {
      throw new Error(`filter.${key} must be an integer between 1 and 1800000`);
    }
  }
  for (const key of ["maxBufferBytes", "maxRequestBytes"]) {
    if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > RESPONSE_LIMIT) {
      throw new Error(`filter.${key} must be an integer between 1 and ${RESPONSE_LIMIT}`);
    }
  }
  return result;
}

function defaultRetryDelay(kind, index, headers, now = Date.now(), random = Math.random, delayTable = RETRY_DELAYS) {
  const delays = delayTable?.[kind] ?? RETRY_DELAYS[kind];
  let serverDelay = 0;
  for (const name of ["retry-after-ms", "x-ms-retry-after-ms"]) {
    const raw = headers?.get?.(name);
    if (raw === null || raw === undefined) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) serverDelay = Math.max(serverDelay, value);
  }
  const retryAfter = headers?.get?.("retry-after");
  if (retryAfter !== null && retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(value) && value >= 0) serverDelay = Math.max(serverDelay, value);
  }
  return Math.max(delays[Math.min(index, delays.length - 1)], serverDelay)
    + (kind === "rateLimit" ? Math.floor(random() * 1000) : 0);
}

function abortReason(signal) {
  return signal.reason ?? new DOMException("The request was canceled.", "AbortError");
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(abortReason(signal)); };
    Promise.resolve(promise).then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); }
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function sleep(ms, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function attemptScope(signal, idleTimeoutMs) {
  const controller = new AbortController();
  let timer;
  const abort = () => controller.abort(abortReason(signal));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new FilterError(
      "upstream_idle_timeout", "Upstream stopped sending data before completion.", 502
    )), idleTimeoutMs);
  };
  touch();
  return {
    signal: controller.signal,
    touch,
    close(cancel = false) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (cancel && !controller.signal.aborted) controller.abort();
    }
  };
}

function stopReader(reader) {
  if (!reader) return;
  reader.cancel().catch(() => {});
  try { reader.releaseLock(); } catch {}
}

function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function prefixChunks(chunks, length) {
  const result = [];
  for (const chunk of chunks) {
    if (length <= 0) break;
    result.push(chunk.byteLength <= length ? chunk : chunk.subarray(0, length));
    length -= chunk.byteLength;
  }
  return result;
}

function responseHeaders(headers) {
  const result = new Headers(headers);
  const named = String(result.get("connection") ?? "").split(",").map(name => name.trim());
  for (const name of [...named, "connection", "keep-alive", "transfer-encoding", "trailer",
    "content-length", "content-encoding"]) {
    if (name) result.delete(name);
  }
  return result;
}

function jsonResponse(error, status = 400, headers, protocol = "responses") {
  const result = responseHeaders(headers);
  result.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(errorEnvelope({ ...error, message: error.message }, status, protocol)), { status, headers: result });
}

function bytesResponse(bytes, response) {
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers)
  });
}

async function readRequest(request, signal, limit) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) return concatBytes(chunks);
      size += value.byteLength;
      if (size > limit) throw new FilterError("request_too_large", "Request exceeds filter size limit.", 413);
      chunks.push(value);
    }
  } finally {
    stopReader(reader);
  }
}

async function readErrorResponse(response, attempt) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array() };
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), attempt.signal);
      if (done) { reader.releaseLock(); return { bytes: concatBytes(chunks) }; }
      attempt.touch();
      chunks.push(value);
      size += value.byteLength;
      // Oversized errors are forwarded, not fully allocated or guessed at.
      if (size > ERROR_LIMIT) return { reader, chunks };
    }
  } catch (error) {
    stopReader(reader);
    throw error;
  }
}

async function readSseResponse(response, attempt, limit, protocol, request) {
  const reader = response.body?.getReader();
  if (!reader) throw new FilterError("stream_incomplete", "Upstream returned an empty SSE stream.", 502);
  const chunks = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const inspector = createSseInspector(protocol, request);
  let size = 0;
  let consumed = 0;
  let pending = "";
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), attempt.signal);
      if (done) {
        const terminal = inspector.accept(pending + decoder.decode());
        if (terminal) return { ...terminal, chunks };
        return { ...inspector.finish(), chunks };
      }
      attempt.touch();
      size += value.byteLength;
      if (size > limit) throw new FilterError("response_too_large", "Buffered response exceeds filter size limit.", 502);
      chunks.push(value);
      pending += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        const terminal = inspector.accept(pending.slice(0, boundary.index));
        consumed += new TextEncoder().encode(pending.slice(0, boundary.index + boundary[0].length)).byteLength;
        if (terminal) return { ...terminal, chunks: prefixChunks(chunks, consumed) };
        pending = pending.slice(boundary.index + boundary[0].length);
      }
    }
  } finally {
    stopReader(reader);
  }
}

async function readJsonResponse(response, attempt, limit, protocol) {
  const reader = response.body?.getReader();
  if (!reader) return { kind: "complete", chunks: [] };
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), attempt.signal);
      if (done) break;
      attempt.touch();
      size += value.byteLength;
      if (size > limit) throw new FilterError("response_too_large", "Buffered response exceeds filter size limit.", 502);
      chunks.push(value);
    }
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(concatBytes(chunks))); }
    catch { throw new FilterError("stream_incomplete", "The upstream JSON response was incomplete or malformed.", 502); }
    if (protocol === "responses" && value?.status === "failed") value = { type: "response.failed", response: value };
    return { kind: errorOf(value) !== null ? "error" : "complete", value, chunks };
  } finally { stopReader(reader); }
}

function forwardResponse(response, attempt, finish, prefix = []) {
  const reader = response.body?.getReader();
  return forwardReader(response, reader, attempt, finish, prefix);
}

function forwardReader(response, reader, attempt, finish, prefix = []) {
  if (!reader) { attempt.close(); finish(response.ok ? "success" : "failed"); return response; }
  let stopped = false;
  let abort;
  const stop = outcome => {
    if (stopped) return;
    stopped = true;
    attempt.signal.removeEventListener("abort", abort);
    stopReader(reader);
    attempt.close(outcome === "canceled");
    finish(outcome);
  };
  const body = new ReadableStream({
    start(controller) {
      abort = () => { controller.error(abortReason(attempt.signal)); stop("failed"); };
      if (attempt.signal.aborted) { abort(); return; }
      attempt.signal.addEventListener("abort", abort, { once: true });
      for (const chunk of prefix) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await abortable(reader.read(), attempt.signal);
        if (stopped) return;
        if (done) { controller.close(); stop(response.ok ? "success" : "failed"); }
        else { attempt.touch(); controller.enqueue(value); }
      } catch (error) {
        if (!stopped) { controller.error(error); stop("failed"); }
      }
    },
    cancel() { stop("canceled"); }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers)
  });
}

async function fetchWithFilter(input, init = {}, options = {}) {
  const settings = normalizeFilterOptions(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = input instanceof Request ? input.url : String(input);
  const protocol = protocolOfURL(url);
  if (!settings.enabled || method !== "POST" || !protocol) {
    return fetchImpl(input, init);
  }

  const inputHeaders = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  const encoding = inputHeaders.get("content-encoding");
  const contentType = inputHeaders.get("content-type");
  if ((encoding && encoding !== "identity") || (contentType && !/^(?:application\/(?:[\w.+-]+\+)?json|text\/plain)\b/i.test(contentType))) {
    return fetchImpl(input, init);
  }

  const request = new Request(input, init);
  const controller = new AbortController();
  const abort = () => controller.abort(abortReason(request.signal));
  if (request.signal.aborted) abort();
  else request.signal.addEventListener("abort", abort, { once: true });
  const startedAt = Date.now();
  const deadlineAt = startedAt + settings.deadlineMs;
  const timer = setTimeout(() => controller.abort(new FilterError(
    "request_deadline", "The filter's total request deadline was reached.", 502
  )), settings.deadlineMs);
  let finished = false;
  let consumerCanceled = false;
  let handedOff = false;
  let attempt;
  const emit = (event, data = {}) => {
    try { options.onEvent?.(event, { requestId: options.requestId, ...data }); } catch {}
  };
  const finish = outcome => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    emit("request-finished", {
      outcome: request.signal.aborted || consumerCanceled ? "canceled" : outcome,
      durationMs: Date.now() - startedAt
    });
  };

  let accept;
  const accepted = new Promise(resolve => { accept = resolve; });
  const work = (async () => {
    try {
      let body = await readRequest(request, controller.signal, settings.maxRequestBytes);
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(body)); }
      catch { throw new FilterError("invalid_request_json", "Responses request is not valid JSON."); }
      if (protocol === "responses") validateResponsesRequest(parsed);
      else if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FilterError("invalid_request_json", "The inference request must be a JSON object.");
      accept(parsed.stream === true || (protocol === "gemini" && (/:streamGenerateContent(?:\?|$)/.test(url) || new URL(url).searchParams.get("alt") === "sse")));
      let cleaned = false;
      let retries = 0;
      const retriesByKind = { resource: 0, rateLimit: 0, transport: 0, availability: 0 };
      const retryProfile = RETRY_PROFILES[settings.retryProfile];
      const retryDelay = options.retryDelay ??
        ((kind, index, headers) => defaultRetryDelay(kind, index, headers, Date.now(), Math.random, retryProfile.delays));
      emit("history-preserved");
      emit("request-started", { maxRetries: retryProfile.maxRetries, deadlineMs: settings.deadlineMs });

      const schedule = async (kind, response, cleanupCode = null) => {
        if (!kind) return false;
        if (controller.signal.aborted) throw abortReason(controller.signal);
        const kindRetry = retriesByKind[kind];
        const exhausted = retries >= retryProfile.maxRetries || kindRetry >= retryProfile.limits[kind];
        const delayMs = exhausted ? 0 : retryDelay(kind, kindRetry, response?.headers);
        if (exhausted || !Number.isFinite(delayMs) || delayMs < 0 || Date.now() + delayMs >= deadlineAt) {
          emit("retry-exhausted", { kind, retries, kindRetries: kindRetry, deadline: !exhausted });
          return false;
        }
        if (cleanupCode && !cleaned) {
          try {
            const result = cleanResponsesRequest(parsed);
            parsed = result.body;
            body = new TextEncoder().encode(JSON.stringify(parsed));
            cleaned = true;
            emit("history-cleanup", {
              errorCode: cleanupCode, removed: result.removed, removedItemIds: result.removedItemIds
            });
          } catch (error) {
            emit("cleanup-refused", { code: error.code });
            return jsonResponse(error, error.status || 400, response?.headers, protocol);
          }
        }
        retries++;
        retriesByKind[kind]++;
        emit("retry-scheduled", { kind, retry: retries, kindRetry: retriesByKind[kind], delayMs });
        await sleep(delayMs, controller.signal);
        emit("retry-dispatched", { kind, retry: retries, kindRetry: retriesByKind[kind] });
        return true;
      };

      while (true) {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        attempt = attemptScope(controller.signal, settings.idleTimeoutMs);
        let response;
        try {
          const headers = new Headers(request.headers);
          headers.delete("content-length");
          headers.delete("content-encoding");
          headers.delete("expect");
          if (!headers.has("content-type")) headers.set("content-type", "application/json");
          response = await abortable(fetchImpl(request.url, {
            ...init,
            method: request.method,
            headers,
            body,
            signal: attempt.signal,
            cache: request.cache,
            credentials: request.credentials,
            redirect: request.redirect,
            referrerPolicy: request.referrerPolicy
          }), attempt.signal);
          attempt.touch();

          if (response.status >= 400) {
            const result = await readErrorResponse(response, attempt);
            if (result.reader) {
              handedOff = true;
              return forwardReader(response, result.reader, attempt, finish, result.chunks);
            }
            attempt.close();
            const text = new TextDecoder().decode(result.bytes);
            let value;
            try { value = JSON.parse(text); } catch {}
            const detected = retryErrorClass(value, protocol);
            const cleanupCode = response.status === 400 ? historyErrorCode(value, protocol) : null;
            const alb = response.status === 400 && isAlbBadRequestPage(
              value ? value.error?.code === "cc_switch_upstream_error" ? value.error.message : "" : text
            );
            // Some AnyRouter gateway failures have no JSON error body. A bare
            // 429 or 503/504 still carries enough status information to retry
            // within the small AnyRouter budget, while JSON quota/auth errors
            // continue to fail closed.
            const bareStatusKind = value === undefined &&
              (response.status === 429 ? "rateLimit"
                : response.status === 503 || response.status === 504 ? "availability"
                  : null);
            const kind = cleanupCode ? "resource" : alb ? "transport" :
              detected === "transport" && [408, 500, 502, 503, 504, 529].includes(response.status) ? "transport" :
              detected === "resource" && response.status === 400 ? "resource" :
              detected === "rateLimit" && [400, 429, 503].includes(response.status) ? "rateLimit" :
              detected === "availability" && [429, 500, 502, 503, 504, 529].includes(response.status) ? "availability" :
                bareStatusKind;
            emit("http-error", { status: response.status, kind: kind || "other", errorCode: cleanupCode });
            const scheduled = await schedule(kind, response, cleanupCode);
            if (scheduled === true) continue;
            finish("failed");
            return scheduled instanceof Response ? scheduled : bytesResponse(result.bytes, {
              status: response.status, statusText: response.statusText, headers: errorRoutingHeaders(value, response.headers)
            });
          }

          const type = response.headers.get("content-type") || "";
          const streaming = /^text\/event-stream\b/i.test(type);
          const json = /^application\/(?:[\w.+-]+\+)?json\b/i.test(type);
          if (response.status !== 200 || (!streaming && !json)) {
            handedOff = true;
            return forwardResponse(response, attempt, finish);
          }
          const result = streaming
            ? await readSseResponse(response, attempt, settings.maxBufferBytes, protocol, parsed)
            : await readJsonResponse(response, attempt, settings.maxBufferBytes, protocol);
          attempt.close();
          if (result.kind !== "error") {
            finish(result.kind === "response.incomplete" ? "failed" : "success");
            return bytesResponse(concatBytes(result.chunks), response);
          }
          const cleanupCode = historyErrorCode(result.value, protocol);
          const kind = cleanupCode ? "resource" : retryErrorClass(result.value, protocol);
          emit(streaming ? "stream-error" : "json-error", { kind: kind || "other", errorCode: cleanupCode });
          const scheduled = await schedule(kind, response, cleanupCode);
          if (scheduled === true) continue;
          finish("failed");
          if (scheduled instanceof Response) return scheduled;
          const detail = errorOf(result.value) || result.value;
          return jsonResponse({
            ...detail,
            code: detail.code || (kind === "transport" ? "upstream_failed_without_details" : "upstream_error"),
            message: detail.message || "Upstream returned an error before response.completed."
          }, cleanupCode ? 502 : failureStatus(detail), errorRoutingHeaders(result.value, response.headers), protocol);
        } catch (error) {
          attempt.close(true);
          if (controller.signal.aborted) throw abortReason(controller.signal);
          if (error.retryable === false) throw new FilterError(error.code || "request_rejected", error.message || "The selected account rejected this request.", error.status || 409);
          if (error.code === "response_too_large") throw error;
          emit("transport-error", { code: error.code || "stream_incomplete" });
          if (await schedule("transport", response) === true) continue;
          throw new FilterError("stream_incomplete", "Upstream stream disconnected before completion or timed out.", 502);
        }
      }
    } catch (error) {
      finish(request.signal.aborted ? "canceled" : "failed");
      if (request.signal.aborted || consumerCanceled) throw abortReason(controller.signal);
      return jsonResponse(error instanceof FilterError ? error : {
        code: "local_filter_error", message: "The filter could not handle this request."
      }, error.status || 502, undefined, protocol);
    } finally {
      accept(false);
      if (!handedOff) {
        attempt?.close(true);
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
      }
    }
  })();
  if (!await accepted) return work;
  return deliverWithKeepalive(work, {
    protocol, keepaliveMs: settings.keepaliveMs, maxBufferBytes: settings.maxBufferBytes, signal: request.signal,
    onStart() { emit("sse-keepalive-started", { protocol, intervalMs: settings.keepaliveMs }); },
    cancel(reason) { consumerCanceled = true; controller.abort(reason); }
  });
}

function createFilteredFetch(fetchImpl, options = {}) {
  const settings = normalizeFilterOptions(options);
  let nextRequestId = 0;
  return (input, init = {}) => fetchWithFilter(input, init, {
    ...options, ...settings, fetchImpl, requestId: ++nextRequestId
  });
}

export { cleanResponsesRequest, createFilteredFetch, defaultRetryDelay, fetchWithFilter,
  historyErrorCode, normalizeFilterOptions, retryErrorClass };
export const _internal = { cleanResponsesRequest, createFilteredFetch, defaultRetryDelay,
  fetchWithFilter, historyErrorCode, normalizeFilterOptions, retryErrorClass, RETRY_PROFILES, RETRY_LIMITS, MAX_RETRIES };


