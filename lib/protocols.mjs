export function protocolOfURL(value) {
  const path = new URL(value instanceof Request ? value.url : String(value)).pathname;
  if (/\/responses\/?$/.test(path)) return "responses";
  if (/\/chat\/completions\/?$/.test(path)) return "chat";
  if (/\/messages\/?$/.test(path)) return "anthropic";
  if (/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(path)) return "gemini";
  return null;
}

export function errorOf(value) {
  const error = value?.error ?? value?.response?.error;
  if (error && typeof error === "object" && !Array.isArray(error)) return error;
  if (value?.type === "response.failed") return {};
  if (value?.type === "error" && typeof value.message === "string") return value;
  return null;
}

function incomplete(message) {
  return Object.assign(new Error(message), { code: "stream_incomplete", status: 502 });
}

function frameData(frame) {
  const lines = frame.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const data = lines.filter(line => line === "data" || line.startsWith("data:"))
    .map(line => line.slice(5).replace(/^ /, "")).join("\n");
  const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
  return { event, data };
}

export function createSseInspector(protocol, request = {}) {
  const choices = new Map();
  const wanted = protocol === "gemini" ? request.generationConfig?.candidateCount : request.n;
  const count = Number.isInteger(wanted) && wanted > 0 ? wanted : 1;
  let blocked = false;

  function allFinished() {
    return choices.size >= count && [...choices.values()].every(Boolean);
  }

  function accept(frame) {
    const { event, data } = frameData(frame);
    if (!data.trim()) return null;
    if (data.trim() === "[DONE]") {
      if (protocol !== "chat") return null;
      if (!allFinished()) throw incomplete("Chat SSE ended without terminal results for all requested choices.");
      return { kind: "complete" };
    }
    let value;
    try { value = JSON.parse(data); } catch { throw incomplete("The upstream sent malformed SSE JSON."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw incomplete("The upstream sent an invalid SSE value.");
    const type = event || value.type;
    const normalized = type === "error" || type === "response.failed" ? { ...value, type } : value;
    if (errorOf(normalized) !== null) return { kind: "error", value: normalized };
    if (protocol === "responses") {
      if (type === "response.completed" || type === "response.incomplete") return { kind: type };
    } else if (protocol === "anthropic") {
      if (type === "message_stop") return { kind: "complete" };
    } else if (protocol === "chat") {
      for (const choice of value.choices ?? []) {
        if (!Number.isInteger(choice?.index) || choice.index < 0) throw incomplete("The upstream sent a Chat choice without a valid index.");
        const finished = typeof choice.finish_reason === "string" && choice.finish_reason.length > 0;
        choices.set(choice.index, Boolean(choices.get(choice.index)) || finished);
      }
    } else if (protocol === "gemini") {
      if (value.promptFeedback?.blockReason && !(value.candidates?.length)) blocked = true;
      for (const [position, candidate] of (value.candidates ?? []).entries()) {
        const index = candidate.index ?? position;
        if (!Number.isInteger(index) || index < 0) throw incomplete("The upstream sent a Gemini candidate without a valid index.");
        const finished = typeof candidate.finishReason === "string" && candidate.finishReason.length > 0;
        choices.set(index, Boolean(choices.get(index)) || finished);
      }
    }
    return null;
  }

  return {
    accept,
    finish() {
      // Gemini has no DONE sentinel: consume its usage trailers and require both
      // protocol completion and a normally terminated transport.
      if (protocol === "gemini" && (blocked || allFinished())) return { kind: "complete" };
      throw incomplete(`The upstream ${protocol} stream ended before a valid terminal result.`);
    }
  };
}

export function protocolRetryClass(value, protocol) {
  if (protocol === "responses") return null;
  const error = errorOf(value) || value;
  const code = error?.type || error?.status || error?.code;
  if (["overloaded_error", "api_error", "server_error", "upstream_error", "UNAVAILABLE", "INTERNAL"].includes(code)) {
    return "availability";
  }
  // A Gemini RESOURCE_EXHAUSTED error can mean exhausted daily/billing quota.
  // Only an explicit per-minute/second limit is a local rate retry.
  if (protocol === "gemini" && code === "RESOURCE_EXHAUSTED" &&
      /per[ _-]?(?:minute|second)|requests?\s*\/\s*(?:min|sec)/i.test(error.message || "")) return "rateLimit";
  return null;
}

export function failureStatus(error) {
  const codes = [error?.type, error?.status, error?.code].filter(value => typeof value === "string");
  if (codes.some(code => /^(authentication_error|invalid_api_key|unauthorized|UNAUTHENTICATED)$/.test(code))) return 401;
  if (codes.some(code => /^(permission_error|permission_denied|forbidden|PERMISSION_DENIED)$/.test(code))) return 403;
  if (codes.some(code => /^(rate_limit_error|rate_limit_exceeded|insufficient_quota|RESOURCE_EXHAUSTED)$/.test(code))) return 429;
  if (codes.some(code => /^(invalid_request_error|INVALID_ARGUMENT)$/.test(code)) && error?.code !== "invalid_encrypted_content") return 400;
  return 502;
}

export function errorRoutingHeaders(value, original) {
  const headers = new Headers(original);
  const error = errorOf(value) || value;
  if (!headers.has("x-magpie-sign-in") && error?.code !== "invalid_api_key" &&
      /unauthorized client detected/i.test(error?.message || "")) headers.set("x-magpie-sign-in", "kept");
  return headers;
}

export function errorEnvelope(error, status, protocol) {
  const message = error.message || "The upstream request could not be completed.";
  if (protocol === "anthropic") {
    const type = ({ 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 429: "rate_limit_error" })[status] || "api_error";
    return { type: "error", error: { ...error, type, message } };
  }
  if (protocol === "gemini") {
    const name = ({ 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 413: "INVALID_ARGUMENT", 429: "RESOURCE_EXHAUSTED" })[status] || "UNAVAILABLE";
    return { error: { code: status, status: typeof error.status === "string" ? error.status : name, message, ...(Array.isArray(error.details) ? { details: error.details } : {}) } };
  }
  return { error: { ...error, message, type: error.type || "invalid_request_error", code: error.code || "local_filter_error" } };
}
