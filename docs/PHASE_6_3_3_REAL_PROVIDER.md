# ALICE0 — Phase 6.3.3: Real Provider Connection

**Document Version:** 1.0.0
**Target Module:** `server/gateway.js`
**Purpose:** Connect the existing secure local gateway to a **real** OpenAI-compatible provider, with server-authoritative provider and model policy
**Dependencies:** `server/gateway.js` (Phase 6.3.1), `js/ai/httpModelAdapter.js` (Phase 6.3.2)
**Test Suite:** `tests/realProvider.test.mjs`

---

## 1. Purpose

Phase 6.3.1 built the **credential boundary** (a loopback-only gateway).
Phase 6.3.2 built the **client transport** (`HttpModelAdapter`, which speaks only to that gateway).
Phase 6.3.3 makes the upstream side **real**: the gateway can now call Groq, OpenRouter or a local
Ollama instance — while the browser still never sees a key, a provider URL, or an `Authorization`
header.

Nothing in this phase changes *where* trust lives. Two new server-side controls were added, and one
existing weakness was closed:

| # | Control | Why |
| :- | :------ | :-- |
| 1 | **Provider allowlist** | Only server configuration can select a provider. No request field can introduce one. |
| 2 | **Server-authoritative model policy** | The client must not be able to pick an arbitrary — or expensive — model. |
| 3 | **Strict response normalization** | A malformed provider response is an *error*, never a silently-empty success. |

---

## 2. Architecture

The request flow is **unchanged**. Phase 6.3.3 only adds server-side policy inside the gateway box.

```
┌──────────────────────────────────────────────────────────────┐
│                       BROWSER / CLIENT                       │
│  conversation.js → aiBrain.js → HttpModelAdapter             │
│  (NO provider key · NO provider URL · NO Authorization)      │
└───────────────────────────────┬──────────────────────────────┘
                                │ POST <gateway>/api/ai/generate
                                │ { prompt, responseFormat, temperature, model? }
                                ▼
┌──────────────────────────────────────────────────────────────┐
│             LOCAL AI GATEWAY — server/gateway.js             │
│                                                              │
│  1. loopback-only + CORS allowlist + optional trust token    │
│  2. route / method / content-type validation                 │
│  3. rate limit (sliding window) + 32 KB body cap             │
│  4. payload whitelist  ◀── SSRF & credential fields refused  │
│  5. PROVIDER ALLOWLIST              ◀── NEW (6.3.3)          │
│  6. SERVER MODEL POLICY             ◀── NEW (6.3.3)          │
│  7. upstream request, Authorization injected server-side     │
│  8. STRICT response normalization   ◀── NEW (6.3.3)          │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTPS POST /v1/chat/completions
                                │ (fixed endpoint from PROVIDER_CONFIG)
                                ▼
┌──────────────────────────────────────────────────────────────┐
│        CONFIGURED AI PROVIDER (Groq / OpenRouter / Ollama)   │
└──────────────────────────────────────────────────────────────┘
                                │ normalized { text, usage, model }
                                ▼
              HttpModelAdapter → PlanValidator → Agent
                        → Permission Gateway → SkillManager → Skill
```

> **The gateway never executes model output.** It returns text. Generated plans remain untrusted
> data and must still clear `PlanValidator`, the `Agent` step limit, and the Permission Gateway
> before any skill runs.

---

## 3. Supported Providers

Providers are a **frozen, server-side allowlist** (`SUPPORTED_PROVIDERS`, derived from
`PROVIDER_CONFIG`). A provider that is not in this map cannot be selected by any means.

| Provider | Endpoint (fixed, server-side) | Default model | Credential |
| :------- | :---------------------------- | :------------ | :--------- |
| `groq` | `https://api.groq.com/openai/v1/chat/completions` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `meta-llama/llama-3.3-70b-instruct:free` | `OPENROUTER_API_KEY` |
| `ollama` | `<OLLAMA_HOST>/v1/chat/completions` | `llama3.2:3b` | none (local) |
| `mock` | *no upstream — deterministic offline generator* | `mock-model` | none |

There are **no arbitrary upstream URLs**. `resolveUpstreamTarget()` derives the destination only
from this map. The one exception is the server-side `providerEndpoints` constructor/env override,
which can *replace* the destination of a provider that is **already** in the map — it can never add
one, and it rejects non-`http(s)` schemes and URLs containing credentials. It is unreachable from a
request body and exists so tests (and self-hosted relays) can point a known provider at a local
endpoint.

Provider names are resolved with `hasOwnProperty`, so `constructor`, `__proto__` and `toString`
cannot resolve to an inherited `Object.prototype` member and be mistaken for a provider.

---

## 4. Server-Side Environment Configuration

All of it lives in the **server process environment**. None of it can be set from a request.

| Variable | Type | Default | Description |
| :------- | :--- | :------ | :---------- |
| `GATEWAY_PORT` | Number | `3001` | TCP port for the local gateway |
| `GATEWAY_HOST` | String | `127.0.0.1` | Bind interface (loopback) |
| `AI_PROVIDER` | String | `mock` | `groq` \| `openrouter` \| `ollama` \| `mock` |
| `AI_MODEL` | String | *(provider default)* | **Authoritative** upstream model |
| `AI_API_KEY` | String | *none* | Provider-agnostic key; used when the provider-specific variable is unset |
| `AI_ALLOWED_MODELS` | String | *none* | Comma/space-separated server-side model allowlist |
| `AI_ALLOW_CLIENT_MODEL` | Boolean-ish | **off** | Explicit opt-in before *any* client model is considered |
| `AI_MAX_TOKENS` | Number | `1024` | Completion token budget, clamped to 1–4096 |
| `AI_MAX_UPSTREAM_RESPONSE_BYTES` | Number | `1048576` | Provider response cap, absolute max 8 MB |
| `GROQ_API_KEY` | String | *none* | Groq key (server-only) |
| `OPENROUTER_API_KEY` | String | *none* | OpenRouter key (server-only) |
| `OLLAMA_HOST` | String | `http://localhost:11434` | Local Ollama base URL |
| `RATE_LIMIT_PER_MINUTE` | Number | `20` | Requests per minute per client IP |
| `UPSTREAM_TIMEOUT_MS` | Number | `10000` | Upstream request timeout |
| `ALLOWED_ORIGINS` | String | localhost origins | Comma-separated CORS allowlist |
| `LOCAL_TRUST_TOKEN` | String | *none* | Optional `X-Local-Trust-Token` shared secret |

`AI_ALLOW_CLIENT_MODEL` accepts `1` / `true` / `yes` / `on` (case-insensitive). **Anything else,
including a missing value, means off.**

```bash
# Default: offline mock, zero credentials, unchanged behaviour
node server/gateway.js

# Real provider, model pinned server-side
AI_PROVIDER=groq GROQ_API_KEY=... AI_MODEL=llama-3.3-70b-versatile node server/gateway.js

# Real provider, client may choose — but only from the allowlist
AI_PROVIDER=openrouter OPENROUTER_API_KEY=... \
AI_ALLOW_CLIENT_MODEL=true \
AI_ALLOWED_MODELS="meta-llama/llama-3.3-70b-instruct:free,mistralai/mistral-7b-instruct" \
node server/gateway.js
```

---

## 5. API-Key Boundary

The key exists in exactly one place: the gateway process memory.

- **Never** read from the request body, headers, or query string. `authorization`, `apiKey`,
  `api_key`, `token`, `secret`, `credentials` and friends are rejected with HTTP 400.
- **Never** returned to the client. Not in a success body, not in an error body, not in a header.
- **Never** logged. The gateway logs only provider name, effective model, and two booleans; every
  log line passes through `sanitizeForLog()`, and upstream headers/bodies are never logged at all.
- **Never** placed on an enumerable object. `server.aliceConfig` is defined non-enumerable, so
  `JSON.stringify(server)` cannot carry the key out.
- **Never** committed. `.gitignore` now excludes `.env`, `.env.*`, `*.key`, `*.pem` and
  `secrets.*`. Only variable **names** appear in this repo — never values.

### Defence in depth: `redactSecrets()`

The upstream response body is attacker-influenced. A provider (or anything impersonating one) can
echo the request's `Authorization` header back as model content, which the gateway would then
forward to the browser as `text`. Before any model text leaves the gateway, the server's own
credential is scrubbed from it — both the bare value and its `Bearer <value>` form. Replacement is
literal (`split`/`join`), so regex metacharacters inside a key cannot alter matching.

This is a **last line of defence**, not the primary control: the gateway never puts a credential
into a response in the first place.

---

## 6. Model-Selection Policy (server-authoritative)

Implemented in the pure, unit-testable `resolveModelPolicy()`. Precedence — **the server always
wins**:

```
1. AI_MODEL configured
       └─▶ use AI_MODEL. Client model is IGNORED.            source: server-config

2. client sent a model
       ├─ AI_ALLOW_CLIENT_MODEL off          ─▶ 403 rejected
       ├─ no AI_ALLOWED_MODELS configured    ─▶ 403 rejected
       ├─ model not in AI_ALLOWED_MODELS     ─▶ 403 rejected
       └─ model in AI_ALLOWED_MODELS         ─▶ use it       source: client-allowlisted

3. no client model, no AI_MODEL
       └─▶ provider safe default                            source: provider-default
```

Design decisions worth calling out:

- **Rejection is explicit, not silent.** An unauthorized client model gets HTTP 403
  `AI_MODEL_NOT_ALLOWED` rather than a quiet downgrade, so a caller cannot probe which models a
  deployment has by watching which ones "work".
- **An allowlist with no opt-in flag still refuses.** Both gates must be open.
- **Allowlist entries are validated** against the same `MODEL_ID_PATTERN` charset as the client
  field, so a malformed `AI_ALLOWED_MODELS` entry can never smuggle a URL or shell metacharacter
  into an upstream request body.
- **`AI_MODEL` beats an allowlisted client model.** Pinning is pinning.
- The existing client-side charset validation is **kept** as an additional layer — being
  well-formed is necessary but not sufficient.
- The policy is applied **before dispatch**, so an unauthorized model never causes an upstream
  request. `GET /api/health` reports the *effective* model, i.e. exactly what a request would use.

---

## 7. Request Flow (server-side)

1. Loopback check → optional `X-Local-Trust-Token` → CORS allowlist.
2. Route (`/api/ai/generate`), method (`POST`) and `Content-Type` validation.
3. Sliding-window rate limit, then a 32 KB streaming body cap (HTTP 413).
4. `JSON.parse` in a try/catch → HTTP 400 `AI_BAD_REQUEST` on malformed input.
5. `validateClientPayload()` — whitelist `prompt` / `responseFormat` / `temperature` / `model`;
   reject every forbidden key case-insensitively.
6. `resolveModelPolicy()` — server decides the model, or the request is refused.
7. `dispatchToProvider()` — build the OpenAI-compatible payload server-side:

   ```json
   { "model": "<server-authorized>", "messages": [{ "role": "user", "content": "<prompt>" }],
     "temperature": 0.2, "max_tokens": 1024, "response_format": { "type": "json_object" } }
   ```

   `response_format` is omitted when `responseFormat` is `text`. Headers are constructed
   exclusively server-side: `Content-Type`, `Content-Length`, `User-Agent`, `Authorization`
   (from the server key), plus OpenRouter's `HTTP-Referer` / `X-Title`. **No client header is ever
   forwarded.**
8. `normalizeProviderResponse()` → `{ text, usage }`, plus the resolved `model`.

---

## 8. Response Normalization

`normalizeProviderResponse()` validates structure **before** extracting. Every one of the
following is an HTTP 502 `AI_PROVIDER_MALFORMED`, never an empty success:

| Provider response | Result |
| :---------------- | :----- |
| non-JSON / malformed JSON | `AI_PROVIDER_MALFORMED` — "malformed JSON" |
| empty body | `AI_PROVIDER_MALFORMED` — "empty response" |
| non-object JSON (e.g. `[1,2,3]`) | `AI_PROVIDER_MALFORMED` — "unexpected response shape" |
| missing `choices` | `AI_PROVIDER_MALFORMED` — `missing "choices"` |
| empty `choices` array | `AI_PROVIDER_MALFORMED` — "no completion choices" |
| missing/invalid first choice | `AI_PROVIDER_MALFORMED` — "missing a valid first choice" |
| missing `message` | `AI_PROVIDER_MALFORMED` — `missing "message"` |
| missing or non-string `content` | `AI_PROVIDER_MALFORMED` — "missing message content" |
| empty / whitespace-only content | `AI_PROVIDER_MALFORMED` — "empty model response" |
| response body over the byte cap | `AI_PROVIDER_MALFORMED` — stream abandoned, not buffered |

The previous implementation used `parsedData.choices?.[0]?.message?.content || parsedData.response
|| ''`, which turned *every* malformed response into a successful `text: ""`. That is fixed: the
optional-chaining fallback path is gone.

`usage` is reduced to at most three finite numbers (`promptTokens`, `completionTokens`,
`totalTokens`); nothing else from the provider payload is forwarded. Ollama's non-chat
`{ "response": "..." }` shape is still accepted, but **only** when `choices` is absent, and it is
subject to the same non-empty rule.

**The `HttpModelAdapter` response contract is unchanged**: `{ text, usage }` (plus an informational
`model`). The adapter's own `_normalizeResponse()` continues to enforce the output-size cap and
re-runs `assertSafeObject()` on structured output.

---

## 9. Error Handling

Normalized categories; upstream bodies, headers and endpoints are always discarded.

| Condition | HTTP | `error.code` |
| :-------- | :--- | :----------- |
| Missing API key | 503 | `AI_PROVIDER_UNAVAILABLE` (names the *variable*, never a value) |
| Unsupported provider | 500 | `AI_PROVIDER_NOT_SUPPORTED` |
| Unauthorized model | 403 | `AI_MODEL_NOT_ALLOWED` |
| Provider 400 / other 4xx | 502 | `AI_PROVIDER_UNAVAILABLE` |
| Provider 401 | 401 | `AI_UNAUTHORIZED` |
| Provider 403 | 403 | `AI_UNAUTHORIZED` |
| Provider 429 | 429 | `AI_RATE_LIMITED` (numeric `Retry-After` kept internally) |
| Provider 5xx | 502 | `AI_PROVIDER_UNAVAILABLE` |
| Connection failure | 502 | `AI_PROVIDER_UNAVAILABLE` |
| Upstream timeout | 504 | `AI_PROVIDER_TIMEOUT` |
| Malformed / empty / oversized response | 502 | `AI_PROVIDER_MALFORMED` |

Status categories are preserved so a caller can tell "your key is wrong" (401) from "you are being
rate limited" (429) from "the provider is broken" (502) — but the *content* is never relayed.

**There are no automatic retries.** One client request produces exactly one upstream request,
verified by test. Retry policy remains a deliberate later phase.

---

## 10. Security Model

| Threat | Control | Verified by |
| :----- | :------ | :---------- |
| SSRF / arbitrary upstream URL | `FORBIDDEN_CLIENT_KEYS` (27 keys, case-insensitive) + fixed endpoint map | tests 9, 10 |
| Arbitrary provider / hostname / port | Provider allowlist; `hasOwnProperty` lookup; no client-supplied destination | tests 4, 9, 10 |
| Client-controlled `Authorization` | Forbidden field; upstream header built only from the server key | test 11 |
| Client-controlled API key | Forbidden field; key resolved server-side only | test 12 |
| Model-policy bypass | `resolveModelPolicy()`; both gates required; checked pre-dispatch | tests 5–8 |
| Secret leakage in responses | No credential in any envelope; `redactSecrets()` on model text | tests 25, 26 |
| Secret leakage in errors | `clientMessage` is a separate, hand-written string; `internalMessage` never serialized | tests 26 |
| Secret leakage in logs | `sanitizeForLog()`; upstream headers/bodies never logged; non-enumerable config | test 27 |
| Malformed-response smuggling | Strict normalization — no silent empty success | tests 15–19 |
| Oversized response | Streaming byte cap; stream destroyed on overflow | test 24 block |
| Retry amplification | No retry logic anywhere in the dispatcher | test 24 block |
| Model-generated plan execution | Gateway returns text only; no `eval`/`Function`/`child_process` in `server/gateway.js` | tests 28–30 |
| PlanValidator / Agent / Permission bypass | Untouched; sensitive skills still prompt and can be denied | tests 28–30 |

`server/gateway.js` contains no `eval`, `new Function`, `require(`, or `child_process` — verified
by grep. The only values read from `req.headers` are `host` (URL parsing), `origin` (CORS),
`content-type` (validation) and `x-local-trust-token` (local auth); **none** are forwarded upstream.

---

## 11. Testing Strategy

`tests/realProvider.test.mjs` — **201 checks**. Every upstream is a deterministic local
`http.createServer()` bound to `127.0.0.1:0`. The suite performs **zero** real network requests:
no Groq, no OpenRouter, no Ollama, no external DNS.

| Section | Area | Checks |
| :------ | :--- | -----: |
| 1 | Valid real-provider configuration + health | 11 |
| 2 | Mock provider unchanged (offline, no credentials) | 6 |
| 3 | Missing API key | 5 |
| 4 | Unsupported provider + prototype-chain provider names | 7 |
| 5 | `AI_MODEL` is server-authoritative | 7 |
| 6 | Authorized client model (explicit opt-in + allowlist) | 4 |
| 7 | Unauthorized client model | 7 |
| 8 | Unauthorized model never reaches the upstream | 2 |
| 9–12 | SSRF & credential-injection surface (all 27 forbidden keys, both cases) | 18 |
| 13–14 | Successful OpenAI-compatible + structured responses | 10 |
| 15–19 | Malformed / missing-field / empty provider responses | 37 |
| 20–24 | Upstream 401/403/429/5xx, timeout, connection failure, oversize, no-retry | 42 |
| 25–27 | Key never in responses, errors or logs; `sanitizeForLog` / `redactSecrets` | 23 |
| 28–30 | Provider output vs. PlanValidator → Agent → Permission Gateway | 13 |
| — | Endpoint resolution stays server-controlled | 9 |
| | **Total** | **201** |

Integration checks (28–30) drive the **whole** chain against a live local gateway: a hostile
provider returns a plan that invokes a `sensitive` skill while claiming `risk: "safe"`. The plan is
validated, the permission prompt is raised, the user denies it, and the skill never executes.

Existing suites are unchanged and still pass — no security test was weakened or removed to
accommodate this phase.

---

## 12. Mock Mode

`AI_PROVIDER=mock` (the default) remains fully functional with **zero** credentials and **zero**
network access. `executeDeterministicMock()` returns the same `{ text, usage, model }` envelope as
the real path, so the adapter contract is identical in both modes. No existing Phase 6.3.1 / 6.3.2
behaviour regressed: `tests/gateway.test.mjs` (44) and `tests/httpModelAdapter.test.mjs` (140) pass
unmodified.

---

## 13. Limitations

- **OpenAI-compatible chat completions only.** No streaming, no embeddings, no non-chat APIs.
- **No retries, no failover.** A provider failure surfaces immediately; there is no automatic
  fallback to a second provider or to the mock.
- **Single-turn upstream call.** The gateway sends one `user` message; conversation history is
  composed into the prompt by `HttpModelAdapter`, not sent as a message array.
- **`AI_ALLOWED_MODELS` is exact-match.** No wildcards, prefixes, or per-provider scoping.
- **Model policy is per-gateway, not per-user.** There is no multi-tenant model budgeting.
- **Ollama is unauthenticated by design** (`OLLAMA_HOST` is loopback). Exposing Ollama publicly is
  out of scope and unsupported.
- **`AI_API_KEY` is provider-agnostic**, so it cannot express two different keys at once; use the
  provider-specific variable when that matters.
- **Token accounting is advisory.** `usage` is passed through when the provider supplies it; the
  gateway does not enforce a cost budget.
- **Rate limiting is in-memory and per-process.** It resets on restart and is not shared across
  gateway instances.

---

## 14. Out of Scope (later phases)

Retry/backoff policy, streaming responses, multi-provider failover, per-user model quotas,
semantic caching, and prompt-level cost controls.
