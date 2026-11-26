# AnyRouter provider: implementation contract

This document describes the behavior this package implements. It is not a
claim that live site policy, WAF settings or Turnstile availability will remain
stable.

## Requirements

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| R1 | Expose password, GitHub, LinuxDO, browser-session, system access-token and model API-key login paths. Ask only questions relevant to the selected path. | Prompt and authorize tests, plus an isolated Magpie host login. |
| R2 | Treat AnyRouter login and daily check-in as separate operations. | Site-client and provider tests assert `sign_in` is called explicitly after password or session setup. |
| R3 | Make unattended check-in opt-in and require a site password or imported session. | Disabled, missing-credential, wrong-user, captcha, inactive, failed and daily-deduplication tests. |
| R4 | Use `anyrouter.top` for login and every site API. Allow only `anyrouter.top` or the confirmed `fcapp.run` endpoint for model API traffic. | URL-boundary, session-origin, WAF-cookie and migration tests. |
| R5 | Use native Magpie account records, account selection and failover. Do not build a hidden account pool in `fetch`. | Concurrent-account tests and installed-gateway failover test. |
| R6 | Keep site credentials and model keys separate. Never send cookies, passwords, system tokens or `New-API-User` to inference endpoints. | Header-boundary and selected-account tests. |
| R7 | Preserve model/request overrides, discover models per account and do not invent default models or limits. | Catalog, model-metadata and protocol-family tests. |
| R8 | Protect Responses, Chat Completions, Anthropic Messages and Gemini, streaming and non-streaming. | Protocol fixtures, compressed HTTP/SSE tests, cancellation and deadline tests. |
| R9 | Preserve the first request body; repair only exact recoverable Responses history errors; retry within the AnyRouter budget. | Byte-level preservation, negative classification, retry-budget and failed-output tests. |
| R10 | Do not expose secrets or request bodies in logs; do not modify other providers or host configuration. | Config-isolation, log-redaction and source-inspection tests. |
| R11 | Remain portable across Node and Bun without a separate proxy or OS-specific command dependency. | Node suite, installed host test and installed gateway test. |

## Research conclusion

The AnyRouter frontend does not use a successful login response as proof of
daily check-in. The observed contract is:

```text
password check-in:
GET  /login          (only when WAF bootstrap is needed)
GET  /api/status
POST /api/user/login?turnstile=
POST /api/user/sign_in       body: {}

session check-in:
GET  /api/user/self
POST /api/user/sign_in       body: {}
```

The WAF fallback first performs one navigation-style `/login` request to collect
the same anonymous cookies a browser obtains before login. If the response is a
recognized AnyRouter `acw_sc__v2` JS challenge, the plugin executes only that
bounded inline script in an isolated VM with no network, filesystem or process
objects, captures the challenge-set cookie, and retries once. It never loops or
tries to solve Turnstile. If the challenge cannot be completed, the request is
reported as requiring the browser-session handoff.

`sign_in` is a separate site request. It carries the selected site session,
`New-API-User` and `X-Requested-With: XMLHttpRequest`; it must not carry the
model API key as `Authorization`. This differs from the AgentRouter baseline,
where the login response's `checked_in` field can describe the daily result.

`/api/status` currently exposes a dynamic `turnstile_check` flag. When it is
true, password login is refused before credentials are sent. The plugin does
not solve Turnstile. A recognized AnyRouter `acw_sc__v2` inline challenge is
executed in the bounded isolated VM described above; other WAF challenges use
the browser-session handoff.

## Ownership and modules

- Magpie owns account storage, account selection, concurrency, routing,
  cross-account failover and check-in scheduling.
- `index.mjs` assembles provider hooks and wraps only this provider's inference
  transport with the request filter.
- `lib/accounts.mjs` owns versioned credentials, site selection, UID identity,
  migration and capability calculation.
- `lib/site-client.mjs` owns status, password login, profile reads, session
  handoff, key lookup and `sign_in`. It is not wrapped by inference retries.
- `lib/provider.mjs` owns login UX, account persistence, usage and check-in
  orchestration.
- `lib/catalog.mjs` and `lib/model-metadata.mjs` own model discovery and
  per-field metadata resolution.
- `lib/responses-filter.mjs` and `lib/protocols.mjs` own one selected-provider
  attempt, protocol completion checks and permitted retries/cleanup.

## Authentication and persistence

The six methods are independent native buttons:

| Mode | Check-in capability | Site reads | Persistent site secret |
| --- | --- | --- | --- |
| Password, check-in off | No | Read-only session | Session and selected model key; password is not persisted |
| Password, check-in on | Yes | Read-only session | Session, selected model key, username and explicitly authorized password |
| GitHub | Optional opt-in | Read-only session | Imported AnyRouter session and selected model key |
| LinuxDO | Optional opt-in | Read-only session | Imported AnyRouter session and selected model key |
| Browser session | Optional opt-in | Read-only session | Imported AnyRouter session and selected model key |
| System access token | No | Read-only, if accepted | Site token, numeric user ID and selected model key |
| Model API key | No | No site reads | Inference key only |

Password login performs `status -> login -> profile -> key lookup`. The login
response is checked against the profile UID before persistence. If the site
returns `turnstile_check: true`, no password request is sent.

GitHub, LinuxDO and browser-session methods complete login in the user's
browser. The user supplies a `/api/user/self` request copied as cURL or a JSON
session export. Clipboard text is parsed as data, never executed. Only known
AnyRouter origins, a `session` Cookie, optional WAF cookies and a numeric
`New-Api-User` are accepted. The plugin performs a read-only profile request and
requires the returned UID to match the selected account.

The account's site UID is authoritative. Reauthentication, profile refresh and
check-in must not replace it with another user's data. A display alias is not
an account identity. New account names use the verified profile email, then
username, then UID; legacy remarks remain labels and are not promoted to email.

Read existing model keys only. Use the sole active key or an explicitly selected
numeric key ID. Never call the system-token reset endpoint, create a key, rotate
a key or delete a key implicitly. A keyless but otherwise successful site login
is not a usable inference account.

## Site and model API endpoints

The only supported site origin for login, session import, profile reads, key
lookup, usage and check-in is:

- `https://anyrouter.top`

Model API traffic may use either confirmed endpoint:

- `https://anyrouter.top`
- `https://a-ocnfniawgw.cn-shanghai.fcapp.run`

The account stores the selected model API endpoint separately from the fixed
site URL. Selecting the `fcapp.run` API endpoint must not change login, session
handoff, profile, key lookup, usage or check-in traffic. Site credentials are
not copied into inference credentials. Explicit user model API overrides remain
available for manually declared models, but they do not change the fixed site
origin.

An account selects one model API endpoint. Retries stay on that endpoint;
cross-endpoint replay is deliberately excluded to avoid duplicate inference
charges. Magpie's native cross-account failover remains available.

Cookie merging is case-preserving for values and handles `Set-Cookie` rotation,
expiry and deletion. Site requests use Chrome-style browser headers with the
`anyrouter.top` `Origin`/`Referer`, including Chrome client hints. These headers
are best-effort only: they do not emulate a browser TLS fingerprint. A
recognized `acw_sc__v2` inline challenge is executed in the bounded isolated VM,
then retried once with the cookie it sets. Unrecognized WAF challenges remain
manual-action errors and are not retried in a background loop.

## Check-in and balances

Check-in requires an explicit account opt-in, a verified UID and either a saved
password or an imported session. Magpie schedules the call; the plugin has no
independent timer.

For password mode, check-in logs in and verifies the profile before calling
`sign_in`. For session mode, it verifies the profile with a read-only request
before calling `sign_in`. The returned session cookies are merged only after
the account identity is rechecked.

Terminal outcomes are `claimed`, `done`, `captcha`, `inactive` and `ineligible`.
They are deduplicated for the same site UID and Beijing calendar day. A
`failed` outcome, including an HTTP-200 `success:false` response, is not marked
complete and is not persisted as a daily result, so a later scheduled attempt
may retry it. Concurrent calls for the same account/day are coalesced.

Usage is read-only. It never falls back to a password login. A missing quota,
WAF block or site failure produces an unknown balance, not zero. The wallet
balance may inform native routing, but check-in rewards do not create a fake
midnight reset window.

## Models and request boundaries

No model is enabled by default. Official AnyRouter endpoints discover models
through `https://anyrouter.top/api/pricing`, using `model_name` as the model ID,
without probing `/v1/models`. Discovery uses the account's site session or system
access token plus `New-Api-User` when available; API-key-only accounts read
anonymously. Inference keys are never sent to the pricing endpoint, and choosing
the alternate inference endpoint does not move site discovery there.

Pricing supplies catalog entries and their metadata, not a guarantee of API-key
permissions; actual inference still enforces those permissions. Public registry
metadata only enriches discovered or explicitly configured models. A pricing
failure preserves explicitly configured models with the host fallback marker,
without declaring the inference key expired. Custom non-official gateways retain
their `/models` discovery, with pricing used only for metadata enrichment.

Protocol defaults:

- `claude-*` and `*-cc-format`: Anthropic Messages.
- `gemini-*`: Gemini.
- Other names: Responses.

Explicit user model, SDK and API settings take precedence. Metadata resolution
is field-wise: user declaration, authenticated discovery, provider pricing,
corresponding registry, exact manufacturer model, conservative family
consensus, then host fallback. `context`, `input` and `output` remain distinct.
The registry must not invent an input ceiling or an effort tier.

Native request headers are authoritative overrides. Account headers fill missing
fields but are not merged across models. The plugin selects the inference auth
header from the outgoing protocol and never forwards site credentials. It may
restore the codex client identity for Responses when compatibility headers are
enabled, but account overrides still win.

## AnyRouter retry policy

`index.mjs` selects the `anyrouter` profile by default:

| Category | Maximum additional retries | Base delays |
| --- | ---: | --- |
| Resource/history mismatch | 1 | 1 s |
| Rate limit | 3 | 2, 5, 10 s plus jitter |
| Transport | 4 | 1, 2, 4, 8 s |
| Availability | 2 | 5, 15 s |
| Total | 8 | bounded by the total deadline |

`Retry-After`, `retry-after-ms` and `x-ms-retry-after-ms` are lower bounds.
An empty `429` response is classified as a rate-limit retry; empty `503` and
`504` responses are availability retries. A JSON quota, authentication,
permission or model error is not retried merely because its HTTP status is
429/5xx. AnyRouter failover across accounts remains a separate Magpie operation.

## Transport invariants

1. Preserve the original body for the first request and for ordinary retries.
2. Only an exact Responses resource/history error can authorize cleanup.
3. Keep portable message/tool pairs. Refuse references, compaction or encrypted
   items that cannot be reconstructed instead of silently dropping context.
4. Do not apply Responses cleanup to Chat, Anthropic or Gemini. Do not guess
   thinking/signature repairs.
5. Hold SSE content and client tool calls until a protocol-valid terminal event.
   Discard all failed-attempt output. A legitimate refusal or length stop is
   terminal, not a transport failure.
6. Keep usage trailers where the protocol requires them. Comments alone do not
   count as Codex SSE activity; non-content progress events are used while
   buffering.
7. Keepalive does not reset the upstream idle or total deadline. Cancellation
   aborts both reading and backoff.
8. Fast failures preserve status and routing headers. After SSE commitment,
   late failures are encoded in-band with their original status/code; never
   append bare JSON or fake completion.
9. Bound request and response memory. Oversize output fails without delivering a
   partial winning stream.
10. Retrying can duplicate upstream inference or hosted-tool side effects; the
    plugin does not claim exactly-once execution.

## Release gates

- [x] Versioned account state, six login paths and conditional check-in persistence.
- [x] Independent `sign_in`, UID checks, Beijing-day deduplication and failed-result retry behavior.
- [x] Fixed `anyrouter.top` site traffic, two confirmed model API endpoints and WAF cookie handling.
- [x] Responses, Chat, Anthropic and Gemini protection with bounded AnyRouter retries.
- [x] Node unit/integration suite passes.
- [x] Installed Magpie host integration passes with isolated HOME.
- [x] Installed Magpie gateway integration passes with isolated HOME and account failover.
- [ ] Live AnyRouter password/GitHub/LinuxDO/check-in validation with a real account.
- [x] Final documentation and package dry-run match this tree.
- [x] Checksum manifest is regenerated and verified.

The live validation gate is intentionally manual because it can change account
state and may require Turnstile. Automated tests do not use real credentials,
make paid inference calls or mutate a user's Magpie configuration.
