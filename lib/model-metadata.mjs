const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const positive = value => Number.isSafeInteger(value) && value > 0;
const effortValue = value => typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const modalities = ["text", "image", "audio", "video", "pdf"];
const origins = {
  openai: /^(?:gpt-|chatgpt-|codex-|o\d(?:-|$))/i,
  anthropic: /^claude-/i, google: /^gemini-/i, deepseek: /^deepseek-/i,
  xai: /^grok-/i, mistral: /^(?:mistral|magistral|codestral|devstral|pixtral|ministral)[-\d]/i,
  moonshotai: /^(?:kimi-|moonshot-)/i, minimax: /^minimax[-/]/i,
  zai: /^glm-/i, alibaba: /^qwen[-\d]/i
};

function first(sources, read, valid = value => value !== undefined) {
  for (const source of sources) {
    const value = read(source);
    if (valid(value)) return value;
  }
}

function limits(source) {
  const values = {
    context: [source.limit?.context, source.context_length, source.context_window],
    input: [source.limit?.input, source.max_input_tokens, source.inputTokenLimit],
    output: [source.limit?.output, source.max_output_tokens, source.max_tokens, source.outputTokenLimit]
  };
  return Object.fromEntries(Object.entries(values).map(([key, list]) => [key, list.find(positive)]));
}

function controls(source) {
  if (!Array.isArray(source.reasoning_options)) return undefined;
  const options = source.reasoning_options.flatMap(option => {
    if (!option || !["effort", "toggle", "budget_tokens"].includes(option.type)) return [];
    if (option.type !== "effort") return [{ ...option }];
    if (!Array.isArray(option.values)) return [];
    const values = [...new Set(option.values.filter(effortValue))];
    return values.length || option.values.length === 0 ? [{ type: "effort", values }] : [];
  });
  return options.length || source.reasoning_options.length === 0 ? options : undefined;
}

function capabilities(source) {
  const cap = object(source.capabilities), result = { input: {}, output: {} };
  for (const [key, alias] of Object.entries({ reasoning: "reasoning", toolcall: "tool_call", temperature: "temperature", attachment: "attachment" })) {
    const value = first([cap[key], source[alias]], value => value, value => typeof value === "boolean");
    if (value !== undefined) result[key] = value;
  }
  if (result.reasoning === undefined && controls(source)?.length) result.reasoning = true;
  if (result.reasoning === undefined && Object.values(object(source.variants)).some(variant =>
    variant?.disabled !== true && effortValue(variant?.reasoningEffort))) result.reasoning = true;
  const interleaved = cap.interleaved ?? source.interleaved;
  if (typeof interleaved === "boolean" || typeof interleaved?.field === "string") result.interleaved = interleaved;
  for (const direction of ["input", "output"]) {
    const listed = source.modalities?.[direction];
    for (const name of modalities) {
      const value = cap[direction]?.[name];
      if (typeof value === "boolean") result[direction][name] = value;
      else if (Array.isArray(listed)) result[direction][name] = listed.includes(name);
    }
  }
  return result;
}

function consensus(members) {
  if (members.length < 2) return {};
  const same = values => values[0] !== undefined && values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0] : undefined;
  const caps = members.map(capabilities), limit = {}, cap = { input: {}, output: {} };
  for (const key of ["context", "input", "output"]) limit[key] = same(members.map(model => limits(model)[key]));
  for (const key of ["reasoning", "toolcall", "temperature", "attachment", "interleaved"]) cap[key] = same(caps.map(model => model[key]));
  for (const direction of ["input", "output"]) for (const name of modalities) cap[direction][name] = same(caps.map(model => model[direction][name]));
  return { limit, capabilities: cap, reasoning_options: same(members.map(controls)) };
}

function registrySources(id, providerId, registry, declarations) {
  let corresponding = object(registry[providerId]?.models?.[id]);
  const declaredOwner = first(declarations, model => [model.manufacturer, model.owned_by]
    .filter(value => typeof value === "string").map(value => value.toLowerCase()).find(value => Object.hasOwn(origins, value)));
  const prefix = id.split("/")[0].toLowerCase();
  const owner = Object.hasOwn(origins, declaredOwner) ? declaredOwner : Object.hasOwn(origins, prefix) ? prefix :
    Object.keys(origins).find(name => origins[name].test(id.replace(/^models\//i, "")));
  if (!owner) return [corresponding];
  const canonical = id.replace(new RegExp(`^(?:${owner}/|models/)`, "i"), "");
  if (!Object.keys(corresponding).length) corresponding = object(registry[providerId]?.models?.[canonical]);
  const models = object(registry[owner]?.models);
  const exact = object(models[canonical]);
  // Dated aliases require agreement among known versions of the complete
  // base model. A single current alias is not evidence about every snapshot.
  const undated = value => value.replace(/-\d{4}-?\d{2}-?\d{2}$/, "");
  const stem = undated(canonical);
  const snapshot = stem !== canonical ? consensus(Object.entries(models).filter(([name]) => undated(name) === stem).map(([, model]) => model)) : {};
  const family = first([...declarations, corresponding, exact, snapshot], model => model.family, value => typeof value === "string" && value.length > 0);
  const related = family ? Object.values(models).filter(model => model?.family === family) : [];
  return [corresponding, exact, snapshot, consensus(related)];
}

export function resolveModelMetadata({ id, providerId, registry = {}, user = {}, row = {}, pricing = {}, base = {} }) {
  const declared = [user, row, pricing].map(object);
  const owned = [...declared, object(base)];
  const sources = [...declared, ...registrySources(id, providerId, object(registry), declared), object(base)];
  const limitSources = sources.map(limits);
  const limit = {
    context: first(limitSources, value => value.context, positive) ?? 0,
    output: first(limitSources, value => value.output, positive) ?? 0,
    // Magpie serves a plugin model's input cap as the window agents are
    // told (and Codex is exported), so a maker's spec inherited from the
    // registry must not pose as one: only the user's, the site's or the
    // host's own word sets input.
    input: first(owned.map(limits), value => value.input, positive) ?? 0
  };
  // Do not publish inherited sub-limits that cannot fit a provider's smaller
  // context. Unknown (0) is safer than silently conflating input with context.
  for (const key of ["input", "output"]) if (limit.context && limit[key] > limit.context) {
    if (limitSources.findIndex(source => positive(source[key])) < limitSources.findIndex(source => positive(source.context))) limit.context = 0;
    else limit[key] = 0;
  }
  const capSources = sources.map(capabilities), cap = { input: {}, output: {} };
  for (const key of ["reasoning", "toolcall", "temperature", "attachment", "interleaved"]) {
    const value = first(capSources, source => source[key]);
    if (value !== undefined) cap[key] = value;
  }
  for (const direction of ["input", "output"]) for (const name of modalities) {
    const value = first(capSources, source => source[direction][name]);
    if (value !== undefined) cap[direction][name] = value;
  }
  const reasoningOptions = first(sources, controls);
  const efforts = [...new Set((reasoningOptions ?? []).filter(option => option.type === "effort").flatMap(option => option.values))];
  const variants = {};
  if (reasoningOptions !== undefined) for (const effort of efforts) variants[effort] = { reasoningEffort: effort };
  else Object.assign(variants, first(sources, source => Object.keys(object(source.variants)).length ? source.variants : undefined) ?? {});
  for (const [name, value] of Object.entries(object(user.variants))) {
    if (["__proto__", "constructor", "prototype"].includes(name)) continue;
    if (value === false || value?.disabled === true) delete variants[name];
    else if (value && typeof value === "object") variants[name] = { ...variants[name], ...value };
  }
  for (const [name, value] of Object.entries(variants)) if (value === false || value?.disabled === true) delete variants[name];
  cap.reasoning ??= Boolean(reasoningOptions?.length || Object.keys(variants).length);
  return {
    limit, capabilities: cap, variants: cap.reasoning ? variants : {},
    ...(reasoningOptions !== undefined ? { reasoning_options: reasoningOptions } : {})
  };
}
