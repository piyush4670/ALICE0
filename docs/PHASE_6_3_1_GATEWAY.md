# ALICE0 — Phase 6.3.1: Secure Local AI Gateway

**Document Version:** 1.0.0  
**Target Module:** `server/gateway.js`  
**Purpose:** Local server-side credential boundary and AI proxy for ALICE0  

---

## 1. Overview & Architecture

The ALICE0 Local AI Gateway (`server/gateway.js`) is a lightweight, zero-dependency Node.js HTTP server that acts as a secure reverse-proxy and credential boundary between the client browser and upstream AI providers (Groq, OpenRouter, Ollama, or Mock).

```
┌─────────────────────────────────────────────────────────────┐
│                      BROWSER CLIENT                         │
│   (Runs ALICE UI / AI Brain — NO API KEYS / NO SECRETS)     │
└──────────────────────────────┬──────────────────────────────┘
                               │ POST /api/ai/generate (Same-Origin)
                               │ (Client cannot specify upstream URL)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 LOCAL AI GATEWAY (Node.js)                  │
│  - server/gateway.js (Port 3001)                            │
│  - Reads GROQ_API_KEY / OPENROUTER_API_KEY from process.env │
│  - Enforces in-memory sliding-window rate limits            │
│  - Enforces 32 KB payload limits                            │
│  - Fixed upstream endpoints (SSRF immune)                   │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS POST /v1/chat/completions
                               │ (Bearer <KEY> injected server-side)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 UPSTREAM AI PROVIDER API                    │
│             (Groq Cloud / OpenRouter / Ollama)              │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Why Credentials Are Server-Side Only

1. **Browser Leakage Prevention:** Any API key placed in client JavaScript, HTML, `localStorage`, or client network requests can be extracted by any user, browser extension, or malicious script.
2. **Untrusted Client Origin:** The browser is strictly an untrusted client execution environment.
3. **No Header Spoofing:** Upstream authorization headers (`Authorization: Bearer ...`) are attached exclusively server-side by the gateway proxy.

---

## 3. Configuration & Environment Variables

Configure the gateway using server-side environment variables:

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `GATEWAY_PORT` | Number | `3001` | TCP port for the local gateway server |
| `GATEWAY_HOST` | String | `127.0.0.1` | Host interface to bind (local loopback) |
| `AI_PROVIDER` | String | `mock` | Active provider: `groq`, `openrouter`, `ollama`, or `mock` |
| `AI_MODEL` | String | *(provider default)* | Upstream model identifier |
| `GROQ_API_KEY` | String | *None* | API key for Groq Cloud (server-only) |
| `OPENROUTER_API_KEY`| String | *None* | API key for OpenRouter (server-only) |
| `OLLAMA_HOST` | String | `http://localhost:11434` | Endpoint for local Ollama instance |
| `RATE_LIMIT_PER_MINUTE` | Number | `20` | Max requests per minute per client IP |
| `UPSTREAM_TIMEOUT_MS` | Number | `10000` | Upstream request timeout in milliseconds |
| `ALLOWED_ORIGINS` | String | `http://localhost:3000,...` | Comma-separated list of allowed CORS origins |
| `LOCAL_TRUST_TOKEN` | String | *None* | Optional local trust token (`X-Local-Trust-Token`) |

> **IMPORTANT:** Never commit `.env` files or API keys to Git.

---

## 4. Local Startup

Start the gateway server from the repository root:

```bash
# Start with default mock provider (offline / zero-credential)
node server/gateway.js

# Start with Groq provider
AI_PROVIDER=groq GROQ_API_KEY=your_key_here node server/gateway.js

# Start with local Ollama provider
AI_PROVIDER=ollama OLLAMA_HOST=http://localhost:11434 node server/gateway.js
```

---

## 5. Gateway Endpoints & API Contract

### `POST /api/ai/generate`

#### Request Headers:
- `Content-Type: application/json` (Required)
- `X-Local-Trust-Token: <token>` (Optional, if `LOCAL_TRUST_TOKEN` configured)

#### Request Body:
```json
{
  "prompt": "Research quantum computing and summarize findings",
  "responseFormat": "json",
  "temperature": 0.2
}
```

#### Allowed Request Fields:
- `prompt` (*string, required*): Maximum 10,000 characters.
- `responseFormat` (*string, optional*): `"json"`, `"plan"`, or `"text"` (default `"json"`).
- `temperature` (*number, optional*): `0.0` to `2.0` (default `0.2`).
- `model` (*string, optional*): Sanitized model name matching `/^[a-zA-Z0-9_.:/-]{1,100}$/`.

#### Prohibited Fields (Anti-SSRF):
Client requests containing `url`, `endpoint`, `targetUrl`, `destination`, `headers`, `authorization`, or `apiKey` are rejected with HTTP 400.

#### Success Response (HTTP 200):
```json
{
  "text": "{\"type\": \"plan\", \"goal\": \"...\", \"steps\": [...]}",
  "usage": {
    "prompt_tokens": 120,
    "completion_tokens": 85,
    "total_tokens": 205
  }
}
```

#### Error Response Envelope (HTTP 4xx / 5xx):
```json
{
  "error": {
    "code": "AI_RATE_LIMITED",
    "message": "Rate limit exceeded. Please slow down."
  }
}
```

---

### `GET /api/health`

Returns gateway operational status and active provider name (zero credentials leaked):
```json
{
  "status": "ok",
  "provider": "mock",
  "model": "mock-model"
}
```

---

## 6. Security Model & Enforcements

1. **Loopback Isolation:** The gateway is restricted to local addresses (`127.0.0.1`, `::1`, `localhost`). External network requests to the gateway are rejected with HTTP 403.
2. **SSRF Immunity:** Target upstream endpoints are hardcoded server-side in `PROVIDER_CONFIG`. No client parameter can redirect network requests.
3. **Payload Clamping:** Payloads exceeding 32 KB (32,768 bytes) are terminated during streaming and rejected with HTTP 413 (`AI_PAYLOAD_TOO_LARGE`).
4. **Rate Limiting:** Sliding-window rate limiter tracks requests per IP. Breaches return HTTP 429 (`AI_RATE_LIMITED`) with a `Retry-After: 60` header.
5. **CORS Allowlist:** Explicit origin matching against `ALLOWED_ORIGINS`. Wildcard `*` is strictly forbidden.
6. **Error Sanitization:** Upstream errors, network failures, and stack traces are normalized to standard error envelopes without leaking server paths or secrets.
