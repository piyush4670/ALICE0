# ALICE0 — Phase 6.3: Real AI Integration Architecture Design

**Document Version:** 1.0.0  
**Status:** Approved for Implementation (Design Baseline)  
**Baseline Commit:** `d1f1f53fa09a25ffb1e428b1f12ef8aa89fe9eda` (Phase 6.2 Approved)  
**Target System:** ALICE0 Voice & Multi-Step Task Architecture  

---

## Executive Summary

Phase 6.2 established a model-agnostic, security-bounded AI Brain architecture (`js/ai/aiBrain.js`, `js/ai/planValidator.js`, `js/ai/planSchema.js`, `js/ai/modelAdapter.js`, `js/ai/mockAdapter.js`, `js/ai/contextBuilder.js`, `js/ai/toolDiscovery.js`, `js/ai/memoryAdapter.js`). This layer ensures that any AI model acts strictly as an untrusted plan generator, while execution remains unconditionally governed by the existing safety pipeline:

$$\text{User} \longrightarrow \text{Conversation} \longrightarrow \text{AI Brain} \longrightarrow \text{Plan Validator} \longrightarrow \text{Agent} \longrightarrow \text{Permission Gateway} \longrightarrow \text{SkillManager} \longrightarrow \text{Skill}$$

This document specifies the technical architecture for **Phase 6.3 (Real AI Integration)**, detailing how ALICE0 will interface with real upstream Large Language Model (LLM) providers while maintaining 100% isolation of credentials, strict budget/rate limits, prompt injection defenses, and seamless deterministic fallback.

---

## 1. Recommended Real AI Provider

### Primary Provider: **Groq Cloud API**
- **Selected Model:** `llama-3.3-70b-versatile` (or `llama-3.1-8b-instant` for ultra-fast conversational responses).
- **Endpoint Protocol:** OpenAI-compatible REST API (`/v1/chat/completions`).

### Evaluation & Comparative Analysis:
| Evaluation Dimension | Groq (`llama-3.3-70b`) | OpenAI (`gpt-4o-mini`) | Google Gemini (`1.5 Flash`) | OpenRouter |
| :--- | :--- | :--- | :--- | :--- |
| **Free-Tier Availability** | **Generous Free Tier** (no credit card required) | Paid / Limited trial credits | Free tier with rate limits | Dependent on free upstream models |
| **Latency / Time-to-First-Token** | **200–400 ms (LPU hardware)** | 600–1200 ms | 700–1500 ms | 600–2500 ms (variable) |
| **JSON / Structured Output** | Native `response_format: { type: "json_object" }` | Native JSON mode & strict schema | Native JSON schema support | Dependent on underlying model |
| **Plan Adherence & Tool Logic** | Excellent (Llama 3.3 70B reasoning) | Excellent | Good | Variable |
| **API Format & Lock-in Risk** | **Zero lock-in** (OpenAI standard) | Standard format | Proprietary SDK/REST API | **Zero lock-in** (OpenAI standard) |
| **Student Project Suitability** | **Highest** (free, instant setup, no billing) | Moderate (requires payment card) | High | High |

### Why Groq:
ALICE is primarily a real-time, voice-enabled assistant. Traditional LLM API latency (1.5s–4s) degrades the voice interaction loop. Groq's custom LPU (Language Processing Unit) architecture delivers responses in 200–400ms, matching human conversational pacing while supporting strict JSON output formatting on top-tier open models.

---

## 2. Secondary / Fallback Provider

### Secondary Provider: **OpenRouter**
- **Selected Models:** `meta-llama/llama-3.3-70b-instruct:free`, `meta-llama/llama-3.1-8b-instruct:free`, or low-cost pay-per-token fallbacks.
- **Role:** Automatic remote failover if the primary provider experiences rate limits (HTTP 429), capacity outages (HTTP 503), or service degradation.

### Why OpenRouter:
1. **Zero Protocol Drift:** Uses the identical OpenAI `/v1/chat/completions` schema, allowing the proxy gateway to switch providers without altering payload parsing or prompt formatting.
2. **Provider Redundancy:** Routes across multiple datacenter backends, mitigating single-provider downtime.

---

## 3. Free & Local Option

### Local Provider: **Ollama**
- **Recommended Model:** `llama3.2:3b` or `qwen2.5:3b`.
- **Local Endpoint:** `http://localhost:11434/v1/chat/completions`.
- **Role:** 100% offline, private, and free local inference.

### Built-in Offline Baseline: **ALICE `MockAdapter`**
- **Location:** `js/ai/mockAdapter.js`.
- **Role:** Default zero-dependency offline adapter requiring no external binaries, hardware accelerators, or network connectivity.

---

## 4. Secure API-Key Architecture

### Core Security Invariants:
1. **Zero Client-Side Credentials:** No API keys, secret tokens, or authorization headers may exist in browser JavaScript, `localStorage`, `sessionStorage`, `index.html`, or client configuration files (`js/config.js`).
2. **Local AI Gateway Proxy:** A lightweight local server acts as the credential boundary. The frontend speaks only to the local gateway via relative, same-origin endpoints (`/api/ai/generate`).
3. **Environment Isolation:** Keys reside exclusively in a server-side `.env` file loaded into `process.env` and excluded from version control via `.gitignore`.

### Architecture Flow:
```
┌─────────────────────────────────────────────────────────────┐
│                      BROWSER CLIENT                         │
│  js/conversation.js ──► js/ai/aiBrain.js ──► HttpModelAdapter│
└──────────────────────────────┬──────────────────────────────┘
                               │ POST /api/ai/generate (Same-Origin)
                               │ (NO API KEYS IN PAYLOAD)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 LOCAL AI GATEWAY (Node.js)                  │
│  1. Validate Origin & Referer                               │
│  2. Enforce Rate Limiting & Payload Size Limit (< 32 KB)     │
│  3. Read process.env.GROQ_API_KEY                           │
│  4. Inject Authorization: Bearer <KEY>                      │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS POST /v1/chat/completions
                               │ (Header: Authorization: Bearer <KEY>)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     UPSTREAM AI PROVIDER                    │
│            (Groq Cloud / OpenRouter / Ollama)               │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Backend / Proxy Requirements

The Phase 6.3 backend proxy (`server/gateway.js` or development proxy) must fulfill the following technical requirements:

1. **Zero Heavy Dependencies:** Implemented using native Node.js `node:http` or lightweight standard libraries.
2. **Origin Verification:** Validates that incoming requests originate strictly from the authorized frontend host/port.
3. **SSRF Guarding:** Target upstream URLs are strictly hardcoded server-side; the proxy never accepts arbitrary destination URLs from client requests.
4. **Body Size Limiting:** Inbound JSON request bodies are capped at 32 KB to prevent memory exhaustion attacks.
5. **Rate Limiting:** Enforces client rate limits (e.g., maximum 20 requests per minute per IP).
6. **Error Masking:** Masks upstream authentication errors and stack traces before responding to the client, returning standardized JSON error envelopes: `{ "error": { "message": "Provider unavailable", "code": "AI_GATEWAY_ERROR" } }`.

---

## 6. Real ModelAdapter Design (`HttpModelAdapter`)

The `HttpModelAdapter` will be implemented in `js/ai/httpModelAdapter.js`, inheriting directly from `ModelAdapter` (`js/ai/modelAdapter.js`):

```javascript
// Architecture specification for js/ai/httpModelAdapter.js
import { ModelAdapter, AIProviderError, AITimeoutError, AICancellationError } from './modelAdapter.js';

export class HttpModelAdapter extends ModelAdapter {
    constructor(config = {}) {
        super(config);
        this._endpoint = config.endpoint || '/api/ai/generate';
        this._model = config.model || 'llama-3.3-70b-versatile';
    }

    async generate(prompt, options = {}) {
        const timeoutMs = options.timeout || this._config.timeout || 5000;
        const signal = options.signal || null;

        const requestPayload = {
            prompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
            responseFormat: options.responseFormat || 'json',
            temperature: options.temperature ?? 0.2,
            model: this._model
        };

        const fetchExecution = async () => {
            try {
                const response = await fetch(this._endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestPayload),
                    signal
                });

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    const msg = errData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
                    throw new AIProviderError(msg, { status: response.status });
                }

                const data = await response.json();
                const rawText = data.text || '';

                let structured = null;
                if (options.responseFormat === 'plan' || options.responseFormat === 'json') {
                    structured = this.parseStructuredOutput(rawText);
                }

                return { text: rawText, structured, usage: data.usage || null };
            } catch (err) {
                throw this.normalizeError(err);
            }
        };

        return this.withTimeout(fetchExecution(), timeoutMs, signal);
    }
}
```

---

## 7. Structured JSON & Plan Output

The model prompt instructs the AI provider to return strictly machine-readable JSON adhering to one of two shapes:

### A. Multi-Step Plan Output:
```json
{
  "type": "plan",
  "goal": "research renewable energy, summarize the findings and save to a document",
  "steps": [
    {
      "id": "step_1",
      "skill": "websearch",
      "action": "search",
      "input": "renewable energy breakthroughs",
      "contextKey": "research_result",
      "dependsOn": [],
      "risk": "safe"
    },
    {
      "id": "step_2",
      "skill": "core",
      "operation": "summarize",
      "input": "",
      "inputSource": "research_result",
      "contextKey": "summary_result",
      "dependsOn": ["step_1"],
      "risk": "safe"
    },
    {
      "id": "step_3",
      "skill": "files",
      "action": "create",
      "input": "",
      "inputSource": "summary_result",
      "contextKey": "document_result",
      "filename": "renewable-energy.txt",
      "dependsOn": ["step_2"],
      "risk": "safe"
    }
  ]
}
```

### B. Direct Conversational Response:
```json
{
  "type": "response",
  "response": "Hello! How can I assist you with your tasks today?"
}
```

### Integration with `PlanValidator`:
1. When `type === "plan"`, the payload is fed into `planValidator.validate(plan)`.
2. `PlanValidator` verifies schema compliance, step limits, skill validity, and DAG dependency structure.
3. If valid, the normalized plan is handed to `Agent.executePlan()`.
4. If invalid, the plan is rejected and ALICE immediately invokes the deterministic fallback planner (`taskPlanner.analyze()`).

---

## 8. Prompt Architecture

Prompts are constructed deterministically by `ContextBuilder` (`js/ai/contextBuilder.js`) using strict structural framing:

```
[SYSTEM INSTRUCTIONS]
You are ALICE, an intelligent voice companion engine.
Your goal is to parse user requests into structured declarative plans using ONLY the available tools listed below.
Rules:
1. Return ONLY valid JSON matching the schema. No markdown outside code blocks, no conversational preamble.
2. Propose actions using registered tool names only.
3. NEVER produce executable JavaScript, script tags, or shell commands.
4. If the request is a simple conversational query or greeting, return a direct JSON response.

[AVAILABLE TOOLS]
- websearch: Search the web for current information [Inputs: query (string)] [Risk: safe]
- notes: Manage user notes [Inputs: content (string)] [Risk: safe]
- files: Create and read text documents [Inputs: content (string), filename (string)] [Risk: safe]
- datetime: Retrieve current date and time [Inputs: none] [Risk: safe]
- calculator: Perform arithmetic calculations [Inputs: expression (string)] [Risk: safe]
- core: Internal processing operations [Inputs: operation (string: "summarize")] [Risk: safe]

[RELEVANT CONTEXT & MEMORY]
- Pinned Facts: User prefers concise answers.
- Recalled Memories: topic preference = technology.

[CONVERSATION HISTORY]
User: Hello Alice
ALICE: Hello! How can I help you today?

[CURRENT USER REQUEST]
User Request: "Research quantum computing and save a summary to my notes"
```

---

## 9. Context & Token Limits

To ensure deterministic latency, avoid runaway memory usage, and respect model context windows, strict bounding is enforced at every layer:

| Component | Limit / Boundary | Enforcement Mechanism |
| :--- | :--- | :--- |
| **User Query** | Maximum 500 characters | `AIBrain.processRequest()` input clamp |
| **Conversation History** | Last 6 turns (max 500 chars/turn) | `ContextBuilder.buildContext()` array slice |
| **Memory Search** | Top 3 scored memories | `MemoryAdapter.retrieveRelevantMemory()` |
| **Pinned Facts** | Maximum 3 facts | `MemoryAdapter.retrieveRelevantMemory()` |
| **Tool Declarations** | Clean summaries only (< 1,500 chars) | `ToolDiscovery.formatToolsForPrompt()` |
| **Total Prompt Size** | Maximum 8,000 characters (~2,000 tokens) | `ContextBuilder.formatForPrompt()` |
| **Model Output Tokens** | Maximum 1,024 tokens (~4,000 chars) | Upstream parameter `max_tokens: 1024` |
| **Model Output Size** | Maximum 10,000 characters | `ModelAdapter.parseStructuredOutput()` |
| **Plan Steps** | Maximum 8 steps | `PlanValidator.validate()` & `Agent._stepLimit()` |

---

## 10. Cost & Rate-Limit Controls

1. **Zero Baseline Cost:** Using Groq Cloud Free Tier and OpenRouter Free Tier eliminates operational infrastructure costs for student and development environments.
2. **Client-Side Debouncing:** `ConversationManager` debounces voice/text submissions by 1.5 seconds to prevent accidental double-submits.
3. **Proxy-Level Throttling:** The local gateway enforces a sliding window rate limit of 20 requests per minute per IP.
4. **Token Bounding:** Prompts and completions are capped at small token envelopes (~2,000 input tokens, ~1,024 output tokens).
5. **No Infinite Retry Loops:** Failed requests fail fast to deterministic fallback rather than issuing rapid retry bursts.

---

## 11. Timeout, Retry, and Failure Handling

| Failure Condition | Detection Mechanism | System Reaction | Recovery / Outcome |
| :--- | :--- | :--- | :--- |
| **Network Disconnection** | `fetch()` throws TypeError | Normalized to `AIProviderError` | Immediate fallback to `TaskPlanner.analyze()` |
| **Gateway / API Timeout** | `withTimeout()` exceeds 5000ms | Rejects with `AITimeoutError` | Aborts fetch via `AbortSignal`; engages deterministic fallback |
| **Rate Limit (HTTP 429)** | Response status 429 | Normalized to `AIProviderError` | Logs warning; falls back to deterministic planner |
| **Malformed JSON Response** | `JSON.parse()` syntax error | Rejects with `AIValidationError` | Discards payload; engages deterministic fallback |
| **Plan Validation Failure** | `PlanValidator.validate()` fails | Returns `fallback: true` | Rejects plan; engages deterministic fallback |
| **Disabled Skill Proposed** | Validator detects disabled tool | Returns `fallback: true` | Engages deterministic fallback |

---

## 12. Deterministic Fallback Pipeline

The system guarantees that ALICE0 remains 100% operational even when completely offline or when upstream AI services fail:

```
[User Utterance]
       │
       ▼
[AI Brain + HttpModelAdapter] ──(Network Error / Timeout / 429 / Invalid Plan)──┐
       │                                                                        │
    (Valid Plan)                                                                ▼
       │                                                               [TaskPlanner.analyze]
       ▼                                                               (Deterministic Rule Planner)
[Agent.executePlan()] ◄─────────────────────────────────────────────────────────┤
       │                                                                        │
       ▼                                                                        ▼
[Permission Gateway]                                                   [Single Skill Match]
       │                                                                        │
       ▼                                                                        ▼
[SkillManager.executeByName()]                                         [Basic Response]
```

---

## 13. Privacy & Data Sent to Provider

### Data Permitted to Leave Device:
1. The sanitized current user query.
2. Bounded conversation turns (last 6 turns, scrubbed of credential patterns by `redact()`).
3. Query-relevant memory snippets (top 3 search hits only).
4. Public tool descriptions.

### Data Strictly FORBIDDEN from Leaving Device:
1. Full long-term memory database or raw `localStorage` contents.
2. User authentication PIN, lockout state, or security settings.
3. Filesystem paths outside the sandbox or raw file directory listings.
4. Internal source code, method definitions, or regex patterns.
5. Internal system tokens or integration credentials.

---

## 14. Prompt-Injection & Indirect Injection Defenses

1. **Structural Separation:** User input is framed inside explicit delimiter tags (`User Request: "..."`) in the prompt.
2. **Untrusted Data Model:** The AI model is explicitly treated as untrusted. Its output is parsed purely as declarative data.
3. **Execution Isolation:** Model output cannot invoke JavaScript `eval()`, `Function()`, `<script>` tags, or process shell calls. `containsExecutableCode()` scans all plan fields.
4. **Immutable Security Policies:** Model-declared `risk` values (e.g. claiming a sensitive action is "safe") are ignored. `PermissionManager.gate()` independently determines risk based on registered manifests.
5. **No Blind Data Loops:** Data retrieved by skills (e.g. web search text) is stored as passive text on the agent blackboard (`this._context`) and is never executed as code.

---

## 15. API-Key & Security Risk Assessment

| Threat Vector | Severity | Vulnerability Description | Mitigation Strategy in Phase 6.3 |
| :--- | :--- | :--- | :--- |
| **Client-Side Key Theft** | Critical | Keys exposed in client bundles or network tab | Keys stored in server `.env`; injected only by backend gateway |
| **SSRF via AI Gateway** | High | Gateway manipulated to query internal endpoints | Gateway destination URLs are hardcoded server-side |
| **Gateway Abuse / Flooding** | Medium | Malicious client exhausting provider rate limits | Gateway enforces IP rate-limiting and payload size limits |
| **Tool Poisoning** | High | Model hallucinating or injecting arbitrary tools | `PlanValidator` rejects any skill not in `SkillManager` |
| **Permission Override** | High | Model attempting to delete files without confirmation | `PermissionManager.gate()` unconditionally enforces confirmation |

---

## 16. Required Changes to ALICE0 in Phase 6.3

1. **`server/gateway.js` (New File):** Minimal local Node.js proxy server handling `/api/ai/generate`, key injection, rate limiting, and upstream dispatch.
2. **`js/ai/httpModelAdapter.js` (New File):** Concrete `HttpModelAdapter` extending `ModelAdapter`.
3. **`js/config.js` (Modified):** Update `CONFIG.ai.adapter` to support `'http'` and configure the gateway endpoint path.
4. **`tests/httpModelAdapter.test.mjs` (New File):** Unit test suite for HTTP adapter status handling, timeouts, cancellations, and JSON parsing.
5. **`tests/gatewayIntegration.test.mjs` (New File):** Integration test suite verifying frontend-to-gateway communication and deterministic fallback under simulated outages.

---

## 17. Staged Implementation Plan for Phase 6.3

```
Stage 6.3.1 ────────► Stage 6.3.2 ────────► Stage 6.3.3 ────────► Stage 6.3.4 ────────► Stage 6.3.5
(Gateway Proxy)       (HttpAdapter)         (Prompt Tuning)       (Privacy Scrub)       (E2E Tests)
```

- **Stage 6.3.1: Lightweight Gateway Proxy (`server/gateway.js`)**
  - Implement zero-dependency HTTP proxy reading `.env`.
  - Add origin checking, request size limits (<32KB), and rate limiting.
- **Stage 6.3.2: `HttpModelAdapter` (`js/ai/httpModelAdapter.js`)**
  - Implement `HttpModelAdapter` extending `ModelAdapter`.
  - Implement standard timeout, cancellation, and error normalization.
- **Stage 6.3.3: Structured Prompt & Schema Tuning**
  - Fine-tune JSON system prompt in `ContextBuilder` for Llama 3.3 / Groq.
  - Verify JSON schema compliance with `PlanValidator`.
- **Stage 6.3.4: Privacy Scrubbing & Context Bounding**
  - Apply `redact()` to all prompt inputs and verify bounding limits.
- **Stage 6.3.5: Comprehensive Integration & Fallback Testing**
  - Test simulated API 500/503 errors, 429 rate limits, timeouts, and deterministic fallback behavior.

---

## 18. Risks & Trade-Offs

1. **External Dependency vs. Autonomy:** Real LLM integration introduces network dependencies.  
   *Mitigation:* Retain the deterministic planner (`taskPlanner.js`) as a first-class, automatic fallback.
2. **Latency Variance:** Upstream network jitter can impact voice responsiveness.  
   *Mitigation:* Strict 5000ms client-side timeout with instant fallback to local deterministic planning.
3. **Model Hallucination:** Model may hallucinate parameters or invalid skill names.  
   *Mitigation:* `PlanValidator` rejects unknown skills, invalid DAG graphs, and malformed inputs before reaching execution.

---

## 19. Final Architectural Verdict

$$\mathbf{APPROVED\ FOR\ IMPLEMENTATION}$$

The design strictly isolates credentials, treats model output as untrusted declarative data, preserves all existing security boundaries (`PlanValidator` $\rightarrow$ `Agent` $\rightarrow$ `Permission Gateway` $\rightarrow$ `SkillManager`), and guarantees full offline functionality via deterministic fallback.
