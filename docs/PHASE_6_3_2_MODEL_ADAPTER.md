# ALICE0 — Phase 6.3.2: Real HTTP Model Adapter

**Document Version:** 1.0.0
**Target Module:** `js/ai/httpModelAdapter.js`
**Purpose:** Real, network-based `ModelAdapter` that talks **only** to the ALICE0 local secure gateway
**Dependencies:** `server/gateway.js` (Phase 6.3.1), `js/ai/modelAdapter.js` (error hierarchy)

---

## 1. Overview

Phase 6.2 introduced a model-agnostic AI Brain with a **mock-only** adapter.
Phase 6.3.1 introduced the **secure local gateway** — the single credential boundary for AI providers.
Phase 6.3.2 connects the two: `HttpModelAdapter` is a real `ModelAdapter` implementation whose
**only** network destination is the configured local gateway.

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
│  loopback-only · SSRF-safe · rate limited · 32 KB cap        │
│  injects Authorization: Bearer <PROVIDER KEY> (server-side)  │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTPS POST /v1/chat/completions
                                ▼
┌──────────────────────────────────────────────────────────────┐
│        CONFIGURED AI PROVIDER (Groq / OpenRouter / Ollama)   │
└──────────────────────────────────────────────────────────────┘
```

The adapter inherits from `ModelAdapter` (`js/ai/modelAdapter.js`) and reuses its error hierarchy
(`AIError`, `AITimeoutError`, `AICancellationError`, `AIValidationError`, `AIProviderError`).
**No error classes are duplicated.**

---

## 2. Adapter Architecture

| Concern | Implementation |
| :--- | :--- |
| Base class | `ModelAdapter` (`js/ai/modelAdapter.js`) |
| Transport | `fetch` (injectable via `config.fetchImpl` for tests/hosts) |
| Destination | `resolveGatewayUrl()` — validated, loopback/allowlist only |
| Timeout | internal `AbortController` + base `withTimeout()` backstop |
| Cancellation | external `AbortSignal` → aborts the same controller |
| Size limits | byte-capped streaming read + `CONFIG.ai.maxOutputSize` on text |
| Parsing | safe `JSON.parse` with shape validation |
| Errors | every failure normalized into the existing AI hierarchy |
| Retries | **none** — deliberate retry policy is a later phase |

`generate()` flow:

```
generate(prompt, options)
   ├─ resolve timeout / reject pre-aborted signals
   ├─ create AbortController (+ external signal bridge)
   ├─ buildRequest()          → { url, body, init }   (whitelisted fields only)
   ├─ fetch()                 → HTTP response
   ├─ status guard            → 2xx only (redirects are refused)
   ├─ _readLimitedText()      → byte-capped body read
   ├─ _safeJsonParse()        → object-only payload
   └─ _normalizeResponse()    → { text, structured, usage }
```

`generateStream()` is inherited and yields the final text (no incremental token
streaming is implemented in this phase).

---

## 3. Gateway Communication

### 3.1 Endpoint

`POST <gateway-url>` where `<gateway-url>` defaults to the same-origin path
`/api/ai/generate` and may be pointed at any loopback origin, e.g.
`http://127.0.0.1:8787` (path is appended automatically).

### 3.2 Request contract (whitelisted — nothing else is ever sent)

```json
{
  "prompt": "[SYSTEM INSTRUCTIONS]\n...\n\n[BOUNDED CONTEXT]\n...\n\n[USER REQUEST]\n\"research quantum computing\"",
  "responseFormat": "plan",
  "temperature": 0.2,
  "model": "llama-3.3-70b-versatile"
}
```

| Field | Type | Rules |
| :--- | :--- | :--- |
| `prompt` | string | required, non-empty, ≤ `CONFIG.ai.gateway.maxPromptChars` (10 000) |
| `responseFormat` | string | `json` \| `plan` \| `text` (unknown → `json`) |
| `temperature` | number | clamped to `[0, 2]`, default `CONFIG.ai.temperature` |
| `model` | string? | omitted unless it matches `/^[a-zA-Z0-9_.:/-]{1,100}$/` |

Structured prompts (`{ system, tools, context, history, request }`) are flattened into a
single delimited `prompt` string so the distinction between **system instructions**,
**bounded context**, **conversation history** and **raw user input** survives on the wire
(a prompt-injection defence) while staying inside the Phase 6.3.1 request contract.

### 3.3 Headers

| Header | Value |
| :--- | :--- |
| `Content-Type` | `application/json` (always) |
| `Accept` | `application/json` (always) |
| `X-Local-Trust-Token` | optional, **only** when a local trust token is configured |

Fetch options are fixed: `method: POST`, `cache: 'no-store'`, `credentials: 'omit'`,
`redirect: 'manual'`. No cookies are sent and redirects never silently move the destination.

### 3.4 Response contract

```json
{ "text": "{\"goal\": \"...\", \"steps\": [...]}", "usage": { "prompt_tokens": 120, "completion_tokens": 85, "total_tokens": 205 } }
```

Validation applied before anything is returned:

1. body is a JSON **object** (arrays/rejected)
2. `text` exists and is a non-empty string
3. text length ≤ `CONFIG.ai.maxOutputSize`
4. optional `structured` is a plain object, size-bounded and free of
   `__proto__` / `constructor` / `prototype` keys
5. `json` / `plan` formats are parsed with `parseStructuredOutput()`
6. only `{ text, structured, usage }` is returned — **no other gateway field is forwarded**

`usage` is reduced to `{ promptTokens?, completionTokens?, totalTokens? }`; unknown fields are dropped.

### 3.5 Plan output still goes through PlanValidator

The adapter returns **untrusted data**. `AIBrain.processRequest()` forwards every
`steps[]` payload to `PlanValidator` before anything can reach `Agent`,
the Permission Gateway or a skill. Nothing in this phase changes that path.

---

## 4. Configuration

Client configuration lives in `CONFIG.ai.gateway` (`js/config.js`). It contains
**routing and limits only — never credentials**.

| Key | Default | Meaning |
| :--- | :--- | :--- |
| `gateway.url` | `''` | Empty = resolve at runtime (see below) |
| `gateway.path` | `/api/ai/generate` | Appended when only an origin is configured |
| `gateway.timeout` | `8000` | ms before the request is aborted |
| `gateway.maxResponseBytes` | `65536` | hard client-side response cap |
| `gateway.maxPromptChars` | `10000` | max prompt length accepted client-side |
| `gateway.trustToken` | `''` | Empty = resolve at runtime |
| `gateway.allowedHosts` | `['127.0.0.1','localhost','::1']` | permitted gateway hosts |

### Runtime resolution order

**Gateway URL**
1. `new HttpModelAdapter({ gatewayUrl })`
2. `process.env.AI_GATEWAY_URL` → `process.env.ALICE_GATEWAY_URL`
3. `window.ALICE_GATEWAY_URL`
4. `<meta name="alice-gateway-url" content="…">`
5. `CONFIG.ai.gateway.url` → `CONFIG.ai.gateway.path` → `/api/ai/generate`

**Local trust token** (optional)
1. `new HttpModelAdapter({ trustToken })`
2. `process.env.LOCAL_TRUST_TOKEN` → `process.env.ALICE_GATEWAY_TOKEN`
3. `window.ALICE_GATEWAY_TOKEN`
4. `<meta name="alice-gateway-token" content="…">`
5. `CONFIG.ai.gateway.trustToken`

```bash
# Browser deployment (gateway started separately)
node server/gateway.js                      # Phase 6.3.1 gateway on 127.0.0.1:3001
# The page is served with the gateway URL/token injected by the local server, e.g.
#   window.ALICE_GATEWAY_URL   = 'http://127.0.0.1:8787'
#   window.ALICE_GATEWAY_TOKEN = '<local trust token>'

# Node / test deployment
AI_GATEWAY_URL=http://127.0.0.1:8787 LOCAL_TRUST_TOKEN=… node my-script.mjs
```

### Destination validation

`normalizeGatewayUrl()` refuses:

* any non-`http(s)` scheme (`file:`, `javascript:`, `data:`, …)
* URLs containing inline credentials (`https://user:pass@…`)
* protocol-relative URLs (`//evil.example.com`)
* non-loopback hosts (SSRF / key-exfiltration defence) — only loopback or
  `CONFIG.ai.gateway.allowedHosts` entries are permitted
* relative paths that are not absolute (`relative/path`) or contain `..`

The adapter therefore **cannot** be pointed at `api.groq.com`, `api.openai.com`,
`openrouter.ai`, a cloud metadata address, or any attacker-controlled host.

---

## 5. Timeout Behaviour

| Layer | Mechanism |
| :--- | :--- |
| Primary | internal `AbortController` aborted by a `setTimeout(timeoutMs)` |
| Backstop | base `ModelAdapter.withTimeout()` races the execution promise |
| Error | `AITimeoutError` (`code: AI_TIMEOUT`, `details.timeoutMs`) |

Timeout resolution: `options.timeout` → `config.timeout` → `CONFIG.ai.gateway.timeout`
→ `CONFIG.ai.timeout` → `5000` ms.

The socket is aborted as soon as the deadline expires, so a slow gateway never leaves
a pending request (and never leaves a hanging promise) behind.

---

## 6. Cancellation

`options.signal` (an `AbortSignal`) is bridged to the internal controller:

```
external signal abort → controller.abort() → fetch rejects → AICancellationError
```

* pre-aborted signals reject immediately and send **no** request
* cancellation is always distinguishable from timeout
* listeners are removed and timers cleared in a `finally` block

---

## 7. Error Handling

Every failure is normalized into the existing hierarchy in `js/ai/modelAdapter.js`:

| Condition | Error | Notes |
| :--- | :--- | :--- |
| Connection refused / reset / unreachable | `AIProviderError` | `transportCode` = `ECONNREFUSED`, `EPIPE`, … |
| DNS / network failure | `AIProviderError` | safe message; raw OS text discarded |
| HTTP 4xx (400/401/403/404/405/413/…) | `AIProviderError` | `status` + `gatewayCode` preserved |
| HTTP 429 | `AIProviderError` | `status: 429`, `retryAfter` captured |
| HTTP 5xx | `AIProviderError` | `status` preserved, internals masked |
| Request timeout | `AITimeoutError` | `details.timeoutMs` |
| AbortSignal / user cancel | `AICancellationError` | distinct from timeout |
| Malformed JSON | `AIValidationError` | |
| Empty / whitespace response | `AIValidationError` | |
| Non-object or wrong-shaped payload | `AIValidationError` | |
| Oversized response (> `maxResponseBytes`) | `AIValidationError` | stream cancelled, never fully buffered |
| Output > `CONFIG.ai.maxOutputSize` | `AIValidationError` | |
| Unsafe keys in structured output | `AIValidationError` | prototype-pollution guard |

Messages are sanitized before they are surfaced or logged: whitespace collapsed,
length capped at 300 chars, filesystem paths replaced, `at … (…)` stack frames removed,
and credential-looking tokens run through `redact()` (`CONFIG.security.redactPatterns`).

**No retries.** A failed request fails fast so `AIBrain` can engage deterministic
fallback, rather than multiplying AI requests from the client.

---

## 8. Response Size Limiting

1. If `Content-Length` exceeds the cap → reject immediately, cancel the body.
2. Otherwise the body is read chunk-by-chunk through `response.body.getReader()`;
   the stream is cancelled the moment accumulated bytes exceed the cap.
3. A non-stream fallback (`response.text()`) still enforces the same byte cap.
4. The extracted `text` is additionally bounded by `CONFIG.ai.maxOutputSize`
   (10 000 characters) before parsing or returning.

Result: an oversized or malicious gateway response can never grow an unbounded buffer
in the client, and is never handed to the planner.

---

## 9. AIBrain Integration (no default switch yet)

`js/ai/aiBrain.js` now exposes an adapter registry:

```js
aiBrain.createAdapter('mock')      // → MockAdapter      (deterministic, offline)
aiBrain.createAdapter('http')      // → HttpModelAdapter (local gateway)
aiBrain.getAvailableAdapters()     // → ['mock', 'http']
aiBrain.setAdapter(adapter)        // unchanged; still requires a ModelAdapter
```

* `CONFIG.ai.adapter` remains `'mock'`, so the default and fallback behaviour is unchanged.
* A fresh `new AIBrain()` still installs a `MockAdapter`.
* `MockAdapter` is untouched and remains fully deterministic.
* To opt in later (Phase 6.3.3+): `aiBrain.setAdapter(aiBrain.createAdapter('http'))`.

---

## 10. Security Boundary

Client-side code (`HttpModelAdapter`, `CONFIG`, the browser bundle) never contains:

* ✗ provider API keys
* ✗ provider URLs
* ✗ arbitrary upstream destination URLs
* ✗ arbitrary `Authorization` headers

Guarantees enforced by code and verified by tests:

1. **One destination.** `resolveGatewayUrl()` is the only source of the request URL;
   caller-supplied `url` / `endpoint` / `headers` / `apiKey` options are ignored outright.
2. **No credentials.** The only credential-adjacent header is the optional
   `X-Local-Trust-Token`; browser web storage is never read for configuration.
3. **No cookie or redirect drift.** `credentials: 'omit'`, `redirect: 'manual'`.
4. **Whitelisted body.** Only the four gateway contract fields can ever be serialized.
5. **Bounded and validated responses.** Size caps, shape checks, prototype-pollution guard,
   and strict reduction to `{ text, structured, usage }`.
6. **Sanitized errors.** No stack traces, paths, credentials, or upstream internals.
7. **Unchanged safety pipeline.** `PlanValidator → Agent → Permission Gateway → SkillManager`
   still governs everything the model proposes.

### Why provider credentials are not present in the adapter

The browser is an untrusted execution environment: anything shipped to it — JS bundle,
`CONFIG`, `localStorage`, network tab — is readable by the user, by extensions and by any
injected script. A provider key in the client is a leaked key. Phase 6.3.1 placed every
provider secret behind `server/gateway.js`, which reads it from the server environment and
attaches `Authorization: Bearer …` **only** on the server-side hop. This adapter is the
client half of that boundary: it knows the *local gateway URL* and nothing else, so there
is no credential to leak, no provider URL to hard-code, and no way for the client to
redirect AI traffic to an arbitrary destination.

---

## 11. Testing

`tests/httpModelAdapter.test.mjs` — **140 checks, zero real AI-provider calls.**
All traffic goes to an in-process mock gateway on `127.0.0.1`, plus the real
Phase 6.3.1 gateway running with its zero-egress `mock` provider.

Coverage: successful request · structured response · malformed JSON · empty response ·
HTTP 400 · HTTP 429 · HTTP 500 · connection failure · timeout · AbortSignal cancellation ·
oversized response · malformed gateway response · credential-leak prevention (including
static source inspection) · gateway URL configuration · local trust-token handling ·
MockAdapter regression · deterministic fallback regression · PlanValidator still in the
execution path.

```bash
node tests/httpModelAdapter.test.mjs
```

---

## 12. Out of Scope (later phases)

* Switching `CONFIG.ai.adapter` to `'http'` (default provider wiring)
* Structured prompt/schema tuning for specific models (Phase 6.3.3)
* Privacy scrubbing and redaction of prompt inputs (Phase 6.3.4)
* Retry / backoff policy and provider failover
* Token streaming (`generateStream` currently yields the completed text)
