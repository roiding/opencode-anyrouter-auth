# Upstream Sources and Provenance

This package is a MIT-licensed derivative of the local
`opencode-agentrouter-auth` working tree:

- Source workspace: `/Users/roiding/Documents/ChatGPT/opencode-agentrouter-auth`
- Source HEAD: `ed4e25fba0b23fd5cfca3d38713df44aab04f428`
  (2026-10-29, "Fix model capabilities, SSE liveness, and account identity")
- Repository: https://github.com/roiding/opencode-agentrouter-auth
- The AnyRouter version copies the provider/account/filter architecture as a
  baseline from that working tree, including its local uncommitted changes,
  then replaces the site authentication and check-in contract.

The AgentRouter baseline itself records these behavioral references:

- https://github.com/ZhaoJun233/agentrouter-magpie-plugin
  - Pinned commit: `1049163f2cd95b39b55b9ca23b1d91b139a80423`.
  - Behavioral reference for the Magpie account, login, catalog and wallet
    integration; no AgentRouter runtime source is bundled here.
- https://github.com/yidu456/magpie-auto-codex-filter
  - Policy basis: commit `cd68b072ddf3475203d42661d9cdca3a93212100`.
  - Copyright (c) 2026 alexcarterio and contributors.
  - `lib/responses-filter.mjs` adapts the policy to Web Fetch streams;
    `lib/protocols.mjs` adds protocol-specific framing and error handling.

## AnyRouter behavior research

The AnyRouter-specific flow was checked against the public frontend and status
endpoints on 2026-10-30:

- Status: https://anyrouter.top/api/status
- Frontend bundle observed: https://anyrouter.top/assets/index-Dultz3N6.js
- User-confirmed alternate model API endpoint:
  https://a-ocnfniawgw.cn-shanghai.fcapp.run

The frontend's daily action is a separate `POST /api/user/sign_in` request. A
successful password login or a profile read is not itself proof of a daily
reward. The plugin therefore uses:

```text
password: [/login on WAF fallback] -> /api/status -> /api/user/login?turnstile= -> /api/user/sign_in
session:  /api/user/self -> /api/user/sign_in
```

At the time of inspection `/api/status` reported `turnstile_check:false`, but
this is a dynamic site setting. The implementation checks it before sending a
password and treats `true` as a browser-action requirement. The site may also
return an Aliyun-style WAF challenge. A recognized `acw_sc__v2` inline
challenge is executed in a bounded isolated VM, its cookie is captured, and the
request is retried once. Turnstile and unrecognized challenges are not solved;
browser-session handoff remains the fallback.

Additional behavior references:

- https://github.com/cita-777/metapi/blob/main/src/server/services/platforms/newApi.ts
- https://github.com/awsl404/magpie-api-checkin

These are references for New API-style site operations and check-in behavior,
not bundled source. AnyRouter's actual status, session, Turnstile and WAF
responses remain authoritative.

## Magpie compatibility

The isolated host and gateway tests were run on 2026-10-30 with:

- Magpie `0.1.1993`
- Bun `1.4.4`

The plugin uses the host's keyless API-method support, native account storage,
native account failover and native check-in scheduling. It does not patch
Magpie configuration files, launch a separate proxy or assume a fixed account
pool.

Model metadata and SSE liveness references remain relevant to this derivative:

- Raw public registry: https://models.dev/api.json
- Codex Responses SSE handling:
  https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs
- Magpie's native gateway may hold lead events while another account is tried;
  the plugin's keepalive and timeout behavior is therefore tested through the
  installed gateway, not only through unit fixtures.

Account identity behavior inherited from the baseline:

- New accounts use a UID-verified profile's email, then username, then UID;
  legacy remarks are labels, not canonical emails.
- Display aliases are set through Magpie after login. The plugin does not
  repurpose the `email` prompt as an alias or patch `providers.json`.
- Refreshes preserve existing account names and UIDs so native aliases and
  name-keyed settings are not orphaned.
- Usage omits the optional site username from `usage.user`, so a site login
  does not become a third account name.

This package is self-contained. Runtime sources, tests and documentation live
at the repository root; update this record whenever a new external behavior
reference changes an implementation decision.
