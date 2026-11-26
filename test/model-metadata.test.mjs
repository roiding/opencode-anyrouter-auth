import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalog, createCatalog } from "../lib/catalog.mjs";
import { resolveModelMetadata } from "../lib/model-metadata.mjs";

const profile = (efforts = ["low", "medium", "high", "xhigh"]) => ({
  family: "gpt-fixture", reasoning: true, tool_call: true, temperature: false,
  limit: { context: 1000000, input: 872000, output: 128000 },
  reasoning_options: [{ type: "effort", values: efforts }],
  modalities: { input: ["text", "image", "pdf"], output: ["text"] }
});
const registry = {
  anyrouter: { models: { "gpt-fixture-a": profile(["low", "high"]) } },
  openai: { models: {
    "gpt-fixture-a": profile(["none", "low", "medium", "high"]),
    "gpt-fixture-b": profile(),
    "gpt-fixture-b-2026-09-01": profile(),
    "gpt-unavailable": profile()
  } }
};
const resolve = (extra = {}) => resolveModelMetadata({ id: "gpt-fixture-b", providerId: "anyrouter", registry, ...extra });

test("original registry restores exact model efforts and keeps the maker's input cap to itself", () => {
  const result = resolve({ base: { capabilities: { reasoning: false }, variants: {} } });
  assert.deepEqual(result.limit, { context: 1000000, input: 0, output: 128000 });
  assert.equal(result.capabilities.reasoning, true);
  assert.equal(result.capabilities.toolcall, true);
  assert.equal(result.capabilities.temperature, false);
  assert.equal(result.capabilities.input.image, true);
  assert.equal(result.capabilities.input.audio, false);
  assert.deepEqual(Object.keys(result.variants), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(result.variants.xhigh, { reasoningEffort: "xhigh" });
  assert.equal(result.variants.none, undefined);
});

test("a registry input cap never lowers the window agents are told; a first-party one does", () => {
  const inherited = resolve();
  assert.equal(inherited.limit.input, 0);
  assert.equal(inherited.limit.context, 1000000);
  const pricing = resolve({ pricing: { limit: { input: 400000 } } });
  assert.deepEqual(pricing.limit, { context: 1000000, input: 400000, output: 128000 });
});

test("corresponding provider registry takes priority over the manufacturer's profile", () => {
  assert.deepEqual(Object.keys(resolve({ id: "gpt-fixture-a" }).variants), ["low", "high"]);
  assert.deepEqual(Object.keys(resolve({ id: "openai/gpt-fixture-a" }).variants), ["low", "high"]);
});

test("user, authenticated discovery, public provider metadata, registry resolve per field", () => {
  const result = resolve({
    user: { limit: { input: 12000 }, capabilities: { input: { image: false } }, reasoning_options: [{ type: "effort", values: ["high"] }] },
    row: { limit: { context: 32000 }, tool_call: false },
    pricing: { limit: { output: 8000 }, modalities: { input: ["text", "image"] } }
  });
  assert.deepEqual(result.limit, { context: 32000, input: 12000, output: 8000 });
  assert.deepEqual(Object.keys(result.variants), ["high"]);
  assert.equal(result.capabilities.toolcall, false);
  assert.equal(result.capabilities.input.image, false);
  assert.equal(result.capabilities.input.pdf, false);
  assert.equal(result.capabilities.input.text, true);
});

test("explicit reasoning false disables variants, including inherited host variants", () => {
  const result = resolve({ row: { reasoning: false }, base: { variants: { max: { reasoningEffort: "max" } } } });
  assert.equal(result.capabilities.reasoning, false);
  assert.deepEqual(result.variants, {});
});

test("declared empty reasoning controls do not inherit invented effort levels", () => {
  assert.deepEqual(resolve({ row: { reasoning_options: [] } }).variants, {});
  const toggle = resolve({ row: { reasoning_options: [{ type: "toggle" }] } });
  assert.equal(toggle.capabilities.reasoning, true);
  assert.deepEqual(toggle.variants, {});
});

test("effort declarations imply reasoning without a redundant boolean", () => {
  const result = resolve({ registry: {}, row: { reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
    base: { capabilities: { reasoning: false } } });
  assert.equal(result.capabilities.reasoning, true);
  assert.deepEqual(Object.keys(result.variants), ["low", "high"]);
});

test("user variants customize or disable levels without losing other supported levels", () => {
  const result = resolve({ user: { variants: { high: { reasoningSummary: "detailed" }, xhigh: { disabled: true } } } });
  assert.deepEqual(Object.keys(result.variants), ["low", "medium", "high"]);
  assert.deepEqual(result.variants.high, { reasoningEffort: "high", reasoningSummary: "detailed" });
});

test("an explicit user effort variant takes precedence over an inherited reasoning false", () => {
  const user = { variants: { high: { reasoningEffort: "high" } } };
  const result = resolve({ user, row: { reasoning: false } });
  assert.equal(result.capabilities.reasoning, true);
  assert.deepEqual(result.variants.high, { reasoningEffort: "high" });
  assert.deepEqual(resolve({ user: { ...user, reasoning: false } }).variants, {});
});

test("unknown models, malformed metadata and budget controls never invent fixed tiers", () => {
  const result = resolve({ id: "unknown", row: {
    limit: { context: -1, input: "123", output: Infinity }, reasoning_options: "high", reasoning: "false"
  } });
  assert.deepEqual(result.limit, { context: 0, input: 0, output: 0 });
  assert.deepEqual(result.variants, {});
  const budget = resolve({ id: "unknown", row: { reasoning_options: [{ type: "budget_tokens", min: 1024 }] } });
  assert.equal(budget.capabilities.reasoning, true);
  assert.deepEqual(budget.variants, {});
});

test("limit aliases do not confuse input ceilings with total context", () => {
  const result = resolve({ registry: {}, row: { context_window: 50000, max_input_tokens: 40000, max_output_tokens: 10000 } });
  assert.deepEqual(result.limit, { context: 50000, input: 40000, output: 10000 });
});

test("a smaller provider context cannot inherit an impossible manufacturer input limit", () => {
  const result = resolve({ row: { limit: { context: 32000 } } });
  assert.deepEqual(result.limit, { context: 32000, input: 0, output: 0 });
  const largerInput = resolve({ user: { limit: { input: 2000000 } } });
  assert.equal(largerInput.limit.input, 2000000);
  assert.equal(largerInput.limit.context, 0, "do not let a lower-priority context erase the user's explicit input limit");
});

test("canonical manufacturer prefixes and dated snapshots retain complete model identity", () => {
  assert.deepEqual(Object.keys(resolve({ id: "openai/gpt-fixture-b" }).variants), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(Object.keys(resolve({ id: "OpenAI/gpt-fixture-b" }).variants), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(Object.keys(resolve({ id: "gpt-fixture-b-2026-10-01" }).variants), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(resolve({ id: "gpt-fixture-b-pro" }).variants, {});
  assert.deepEqual(resolve({ id: "gpt-another-generation" }).variants, {});
  assert.deepEqual(resolve({ id: "gpt-fixture-b-2026-10-01", registry: { openai: { models: { "gpt-fixture-b": profile() } } } }).variants, {});
});

test("manufacturer declarations tolerate branding case and malformed account ownership fields", () => {
  const metadata = { openai: { models: { "new-series": profile(["high"]) } } };
  const result = resolve({ id: "new-series", registry: metadata, row: { manufacturer: "OpenAI", owned_by: "relay-operator" } });
  assert.deepEqual(Object.keys(result.variants), ["high"]);
  assert.deepEqual(resolve({ id: "unknown", row: { owned_by: { toString: null } } }).variants, {});
});

test("malformed reasoning controls fall through to a known registry declaration", () => {
  for (const values of ["high", [null, "", 1]]) {
    const result = resolve({ row: { reasoning_options: [{ type: "effort", values }] } });
    assert.deepEqual(Object.keys(result.variants), ["low", "medium", "high", "xhigh"]);
  }
  assert.deepEqual(resolve({ row: { reasoning_options: [{ type: "effort", values: [] }] } }).variants, {});
});

test("declared family fallback requires manufacturer consensus, not a union of efforts", () => {
  const result = resolve({ id: "gpt-fixture-new", row: { family: "gpt-fixture" } });
  assert.equal(result.limit.context, 1000000);
  assert.equal(result.capabilities.reasoning, true);
  assert.deepEqual(result.variants, {}, "family members disagree about none/xhigh");
  const matching = { openai: { models: { "gpt-one": profile(), "gpt-two": profile() } } };
  assert.deepEqual(Object.keys(resolve({ id: "gpt-new", row: { family: "gpt-fixture" }, registry: matching }).variants), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(resolve({ id: "gpt-new", registry: matching }).variants, {}, "names alone do not establish a family");
});

test("metadata enrichment neither expands account availability nor changes model routing", () => {
  const explicit = { models: { friendly: { id: "gpt-fixture-b", limit: { input: 12000 } } } };
  const result = buildCatalog([{ id: "gpt-fixture-b" }], { id: "anyrouter", models: {} },
    { siteURL: "https://anyrouter.top" }, explicit, [{ model_name: "pricing-only", ...profile() }], registry);
  assert.deepEqual(Object.keys(result), ["friendly"]);
  assert.equal(result.friendly.api.id, "gpt-fixture-b");
  assert.equal(result.friendly.api.url, "https://anyrouter.top/v1");
  assert.equal(result.friendly.limit.input, 12000);
  assert.deepEqual(Object.keys(result.friendly.variants), ["low", "medium", "high", "xhigh"]);
});

test("discovery failure still resolves explicit effort overrides without granting registry-only access", async () => {
  const catalog = createCatalog({ explicit: () => ({ models: { manual: { reasoning_options: [{ type: "effort", values: ["high"] }] } } }),
    site: { request: async () => { throw new Error("offline"); } },
    compatibility: () => false, fetchImpl: async () => { throw new Error("offline"); },
    loadRegistry: () => { assert.fail("failed discovery does not need registry availability"); } });
  const result = await catalog({ models: { manual: { capabilities: { reasoning: false } }, "registry-only": profile() } },
    { key: "fixture", siteURL: "https://anyrouter.top" });
  assert.deepEqual(Object.keys(result), ["manual"]);
  assert.deepEqual(Object.keys(result.manual.variants), ["high"]);
  assert.equal(result.manual.capabilities.reasoning, true);
  assert.equal(result[Symbol.for("magpie.fellBack")], true);
});
