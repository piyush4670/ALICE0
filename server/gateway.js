/**
 * ALICE0 Secure Local AI Gateway (Phase 6.3.1 → 6.3.3)
 * ------------------------------------------------------------------
 * Minimal, secure local Node.js gateway that keeps AI provider credentials
 * completely isolated on the server and outside the browser.
 *
 * Architecture:
 *     Browser / HttpModelAdapter
 *             │
 *             ▼ POST /api/ai/generate (same-origin / local)
 *     Local AI Gateway (server/gateway.js)
 *             │ (injects credentials from server environment)
 *             ▼ HTTPS /v1/chat/completions
 *     Configured AI Provider (Groq / OpenRouter / Ollama / Mock)
 *
 * Security Invariants:
 *   - NEVER stores or exposes API keys to client JavaScript
 *   - NEVER forwards client-supplied Authorization headers
 *   - NEVER allows client-specified upstream destination URLs (SSRF protection)
 *   - Enforces strict method/path checking and JSON content-type validation
 *   - Enforces in-memory sliding-window rate limiting (default 20 req/min)
 *   - Enforces 32 KB maximum payload size limit
 *   - Enforces request and upstream timeout limits
 *   - Normalizes errors and provider responses into standardized, safe JSON
 *
 * Phase 6.3.3 — Real Provider Connection
 * ------------------------------------------------------------------
 * The gateway can now talk to a real OpenAI-compatible provider. Three new
 * server-authoritative controls were added, all driven EXCLUSIVELY by the
 * server process environment (never by the request body):
 *
 *   1. PROVIDER ALLOWLIST — only the providers declared in PROVIDER_CONFIG
 *      may be selected, and only the server selects them.
 *   2. MODEL POLICY — `AI_MODEL` is authoritative. A client model may only
 *      ever be used when `AI_ALLOW_CLIENT_MODEL` is on AND the model appears
 *      in the `AI_ALLOWED_MODELS` allowlist. Everything else falls back to
 *      the provider default. An arbitrary client model is never forwarded.
 *   3. STRICT RESPONSE NORMALIZATION — a malformed provider response is an
 *      error, never a silently-empty success.
 *
 * The gateway NEVER executes model output. Generated plans stay untrusted
 * data and must still pass HttpModelAdapter → PlanValidator → Agent →
 * Permission Gateway → SkillManager before anything runs.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

// ==================================================================
// Standard Error Codes
// ==================================================================

export const ERROR_CODES = {
    BAD_REQUEST: 'AI_BAD_REQUEST',
    PAYLOAD_TOO_LARGE: 'AI_PAYLOAD_TOO_LARGE',
    RATE_LIMITED: 'AI_RATE_LIMITED',
    UNAUTHORIZED: 'AI_UNAUTHORIZED',
    NOT_FOUND: 'AI_NOT_FOUND',
    METHOD_NOT_ALLOWED: 'AI_METHOD_NOT_ALLOWED',
    PROVIDER_UNAVAILABLE: 'AI_PROVIDER_UNAVAILABLE',
    PROVIDER_TIMEOUT: 'AI_PROVIDER_TIMEOUT',
    // Phase 6.3.3 — normalized real-provider failure categories
    PROVIDER_NOT_SUPPORTED: 'AI_PROVIDER_NOT_SUPPORTED',
    MODEL_NOT_ALLOWED: 'AI_MODEL_NOT_ALLOWED',
    PROVIDER_MALFORMED: 'AI_PROVIDER_MALFORMED',
    GATEWAY_ERROR: 'AI_GATEWAY_ERROR'
};

// ==================================================================
// Provider Endpoint Map (Server-side Fixed Destinations - SSRF Safe)
// ==================================================================

export const PROVIDER_CONFIG = {
    groq: {
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        defaultModel: 'llama-3.3-70b-versatile',
        apiKeyEnv: 'GROQ_API_KEY'
    },
    openrouter: {
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
        apiKeyEnv: 'OPENROUTER_API_KEY'
    },
    ollama: {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        defaultModel: 'llama3.2:3b',
        apiKeyEnv: null
    },
    mock: {
        endpoint: null,
        defaultModel: 'mock-model',
        apiKeyEnv: null
    }
};

/**
 * The ONLY providers this gateway can ever dispatch to.
 *
 * This is a frozen, server-side allowlist. Provider selection is a server
 * configuration concern: no request field, header or query parameter may
 * introduce a provider, a hostname, a port or an endpoint.
 */
export const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(PROVIDER_CONFIG));

/** Providers that require a server-side API key. */
const KEYED_PROVIDERS = Object.freeze(['groq', 'openrouter']);

// ==================================================================
// Phase 6.3.3 Policy Constants
// ==================================================================

/**
 * Model identifier charset. Reused for BOTH the existing client-field
 * sanitizer and the server-side `AI_ALLOWED_MODELS` allowlist, so an
 * allowlist entry can never smuggle a URL, a space or a shell metacharacter
 * into an upstream request body.
 */
export const MODEL_ID_PATTERN = /^[a-zA-Z0-9_.:/-]{1,100}$/;

/**
 * Request fields a client may never supply. Matched case-insensitively so
 * `Authorization`, `AUTHORIZATION` and `authorization` are all refused.
 * Every entry is either an upstream destination or a credential.
 */
export const FORBIDDEN_CLIENT_KEYS = Object.freeze([
    'url', 'targeturl', 'endpoint', 'destination', 'dest',
    'host', 'hostname', 'port', 'baseurl', 'origin', 'uri', 'path',
    'headers', 'header', 'authorization', 'auth', 'authtoken',
    'apikey', 'api_key', 'accesstoken', 'access_token', 'bearer',
    'token', 'secret', 'credential', 'credentials', 'provider'
]);

/** Hard ceiling on the provider response body we are willing to buffer. */
const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB absolute cap

/** Safe bounds for the server-configured completion token budget. */
const MIN_UPSTREAM_MAX_TOKENS = 1;
const MAX_UPSTREAM_MAX_TOKENS = 4096;
const DEFAULT_UPSTREAM_MAX_TOKENS = 1024;

/** Where a resolved model came from — useful for audits and tests. */
export const MODEL_SOURCE = Object.freeze({
    SERVER: 'server-config',
    CLIENT_ALLOWED: 'client-allowlisted',
    PROVIDER_DEFAULT: 'provider-default'
});

// ==================================================================
// In-Memory Rate Limiter (Sliding Window)
// ==================================================================

export class RateLimiter {
    constructor({ maxRequests = 20, windowMs = 60000 } = {}) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.clients = new Map(); // ip -> { count, resetAt }
        
        // Periodic cleanup every minute
        this._cleanupInterval = setInterval(() => this.cleanup(), this.windowMs);
        if (this._cleanupInterval.unref) {
            this._cleanupInterval.unref();
        }
    }

    isAllowed(clientId) {
        const now = Date.now();
        const record = this.clients.get(clientId);

        if (!record || now > record.resetAt) {
            this.clients.set(clientId, { count: 1, resetAt: now + this.windowMs });
            return { allowed: true, remaining: this.maxRequests - 1, resetAt: now + this.windowMs };
        }

        if (record.count >= this.maxRequests) {
            return { allowed: false, remaining: 0, resetAt: record.resetAt };
        }

        record.count++;
        return { allowed: true, remaining: this.maxRequests - record.count, resetAt: record.resetAt };
    }

    cleanup() {
        const now = Date.now();
        for (const [id, record] of this.clients.entries()) {
            if (now > record.resetAt) {
                this.clients.delete(id);
            }
        }
    }

    destroy() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
    }
}

// ==================================================================
// Gateway Server Factory
// ==================================================================

export function createGatewayServer(customConfig = {}) {
    const config = {
        port: Number(customConfig.port || process.env.GATEWAY_PORT || process.env.PORT || 3001),
        host: customConfig.host || process.env.GATEWAY_HOST || '127.0.0.1',
        provider: (customConfig.provider || process.env.AI_PROVIDER || 'mock').toLowerCase(),
        model: customConfig.model || process.env.AI_MODEL || null,
        groqApiKey: customConfig.groqApiKey || process.env.GROQ_API_KEY || null,
        openrouterApiKey: customConfig.openrouterApiKey || process.env.OPENROUTER_API_KEY || null,
        // Provider-agnostic credential (Phase 6.3.3). Falls back to the
        // provider-specific key when set, so existing deployments keep working.
        apiKey: customConfig.apiKey || process.env.AI_API_KEY || null,
        ollamaHost: customConfig.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434',
        allowedOrigins: customConfig.allowedOrigins || (process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
            : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://localhost:3001', 'http://127.0.0.1:3001']),
        rateLimitPerMinute: Number(customConfig.rateLimitPerMinute || process.env.RATE_LIMIT_PER_MINUTE || 20),
        maxBodySize: Number(customConfig.maxBodySize || 32768), // 32 KB
        upstreamTimeoutMs: Number(customConfig.upstreamTimeoutMs || 10000), // 10s
        localTrustToken: customConfig.localTrustToken || process.env.LOCAL_TRUST_TOKEN || null,
        mockHandler: customConfig.mockHandler || null, // for testing

        // ---- Phase 6.3.3: server-authoritative model policy -------------
        // Every value below is resolved from the SERVER process only. None
        // of them can be influenced by a client request.
        allowedModels: parseAllowedModels(
            customConfig.allowedModels !== undefined ? customConfig.allowedModels : process.env.AI_ALLOWED_MODELS
        ),
        // Explicit opt-in before ANY client model preference is considered.
        // Default: OFF — the client may never choose the model.
        allowClientModel: parseBooleanFlag(
            customConfig.allowClientModel !== undefined ? customConfig.allowClientModel : process.env.AI_ALLOW_CLIENT_MODEL
        ),
        // Completion token budget sent upstream (bounded server-side).
        upstreamMaxTokens: parseBoundedInt(
            customConfig.upstreamMaxTokens !== undefined ? customConfig.upstreamMaxTokens : process.env.AI_MAX_TOKENS,
            DEFAULT_UPSTREAM_MAX_TOKENS,
            MIN_UPSTREAM_MAX_TOKENS,
            MAX_UPSTREAM_MAX_TOKENS
        ),
        // Hard cap on the provider response body we will buffer.
        maxUpstreamResponseBytes: parseBoundedInt(
            customConfig.maxUpstreamResponseBytes !== undefined
                ? customConfig.maxUpstreamResponseBytes
                : process.env.AI_MAX_UPSTREAM_RESPONSE_BYTES,
            1024 * 1024,
            1024,
            MAX_UPSTREAM_RESPONSE_BYTES
        ),
        // Server-side endpoint overrides for the FIXED provider map.
        // Config-only (constructor/env) — deliberately unreachable from a
        // request body, and validated so only http(s) URLs are accepted.
        providerEndpoints: normalizeProviderEndpoints(customConfig.providerEndpoints)
    };

    const rateLimiter = new RateLimiter({
        maxRequests: config.rateLimitPerMinute,
        windowMs: 60000
    });

    const server = http.createServer((req, res) => {
        handleRequest(req, res, config, rateLimiter);
    });

    server.on('close', () => {
        rateLimiter.destroy();
    });

    // Non-enumerable so a config object can never be serialized wholesale
    // into a log line or an error message and take the credential with it.
    Object.defineProperty(server, 'aliceConfig', {
        value: config,
        enumerable: false,
        writable: false,
        configurable: false
    });

    return server;
}

// ==================================================================
// Server-side Configuration Parsing (never client-reachable)
// ==================================================================

/** Parse a comma/space separated model allowlist into a frozen array. */
function parseAllowedModels(raw) {
    if (Array.isArray(raw)) {
        return Object.freeze(
            raw
                .map(entry => (typeof entry === 'string' ? entry.trim() : ''))
                .filter(entry => entry.length > 0 && MODEL_ID_PATTERN.test(entry))
        );
    }
    if (typeof raw !== 'string' || raw.trim().length === 0) return Object.freeze([]);

    return Object.freeze(
        raw
            .split(/[,\s]+/)
            .map(entry => entry.trim())
            // Entries that fail the model charset are dropped rather than
            // forwarded: an allowlist can never become an injection vector.
            .filter(entry => entry.length > 0 && MODEL_ID_PATTERN.test(entry))
    );
}

/** Strict truthy parsing — anything unrecognized means OFF. */
function parseBooleanFlag(raw) {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Parse an integer and clamp it into a safe server-defined range. */
function parseBoundedInt(raw, fallback, min, max) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Validate server-side endpoint overrides.
 *
 * Only absolute http(s) URLs are accepted, credentials in the URL are
 * refused, and an override may only ever REPLACE the destination of a
 * provider that is already in the fixed allowlist. It can never add one.
 */
function normalizeProviderEndpoints(raw) {
    const result = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;

    for (const [key, value] of Object.entries(raw)) {
        const providerKey = String(key).toLowerCase();
        // Cannot introduce a new provider through an endpoint override.
        if (!Object.prototype.hasOwnProperty.call(PROVIDER_CONFIG, providerKey)) continue;
        if (providerKey === 'mock') continue;
        if (typeof value !== 'string' || value.trim().length === 0) continue;

        let parsed;
        try {
            parsed = new URL(value.trim());
        } catch (e) {
            continue;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        if (parsed.username || parsed.password) continue;

        result[providerKey] = parsed.toString();
    }
    return result;
}

// ==================================================================
// Request Router & Handler
// ==================================================================

function handleRequest(req, res, config, rateLimiter) {
    const clientIp = getClientIp(req);
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. Origin & CORS Handling
    const origin = req.headers.origin;
    if (origin) {
        if (config.allowedOrigins.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Local-Trust-Token');
            res.setHeader('Access-Control-Max-Age', '86400');
        } else {
            return sendError(res, 403, ERROR_CODES.UNAUTHORIZED, 'Origin not allowed by gateway policy');
        }
    }

    // Handle preflight OPTIONS
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 2. Local Trust Mechanism (Loopback Check & Optional Token)
    const isLoopback = isLocalAddress(clientIp);
    if (!isLoopback) {
        return sendError(res, 403, ERROR_CODES.UNAUTHORIZED, 'Access denied: gateway is restricted to local connections');
    }

    if (config.localTrustToken) {
        const clientToken = req.headers['x-local-trust-token'];
        if (clientToken !== config.localTrustToken) {
            return sendError(res, 401, ERROR_CODES.UNAUTHORIZED, 'Invalid or missing local trust token');
        }
    }

    // 3. Health Check Route
    if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/health')) {
        // Reports the EFFECTIVE server-side model, i.e. exactly what a
        // request would use. Never reports a credential.
        const effectiveModel = resolveModelPolicy({
            clientModel: null,
            provider: config.provider,
            serverModel: config.model,
            allowedModels: config.allowedModels,
            allowClientModel: config.allowClientModel
        }).model;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            provider: SUPPORTED_PROVIDERS.includes(config.provider) ? config.provider : 'unsupported',
            model: effectiveModel,
            // Observability without disclosure: booleans only, never keys.
            realProvider: config.provider !== 'mock',
            credentialsConfigured: hasProviderCredentials(config),
            clientModelSelectionAllowed: config.allowClientModel === true,
            allowedModelCount: config.allowedModels.length
        }));
        return;
    }

    // 4. Route & Method Validation
    if (pathname !== '/api/ai/generate') {
        return sendError(res, 404, ERROR_CODES.NOT_FOUND, `Route "${pathname}" not found`);
    }

    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS');
        return sendError(res, 405, ERROR_CODES.METHOD_NOT_ALLOWED, `Method "${req.method}" not allowed`);
    }

    // 5. Content-Type Validation
    const contentType = req.headers['content-type'] || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
        return sendError(res, 400, ERROR_CODES.BAD_REQUEST, 'Content-Type must be application/json');
    }

    // 6. Rate Limiting Check
    const rateCheck = rateLimiter.isAllowed(clientIp);
    if (!rateCheck.allowed) {
        res.setHeader('Retry-After', '60');
        return sendError(res, 429, ERROR_CODES.RATE_LIMITED, 'Rate limit exceeded. Please slow down.');
    }

    // 7. Request Body Reading & Size Limiting
    let bodyData = '';
    let bodySize = 0;
    let aborted = false;

    req.on('data', (chunk) => {
        if (aborted) return;
        bodySize += chunk.length;

        if (bodySize > config.maxBodySize) {
            aborted = true;
            req.removeAllListeners('data');
            req.resume(); // drain rest of request
            sendError(res, 413, ERROR_CODES.PAYLOAD_TOO_LARGE, `Payload exceeds limit of ${config.maxBodySize} bytes`);
            return;
        }

        bodyData += chunk;
    });

    req.on('end', async () => {
        if (aborted) return;

        // 8. Safe JSON Parsing
        let parsed;
        try {
            parsed = JSON.parse(bodyData);
        } catch (e) {
            return sendError(res, 400, ERROR_CODES.BAD_REQUEST, 'Malformed JSON in request body');
        }

        // 9. Input Payload Validation & Sanitization
        const validation = validateClientPayload(parsed);
        if (!validation.valid) {
            return sendError(res, 400, ERROR_CODES.BAD_REQUEST, validation.error);
        }

        // 10. Server-Authoritative Model Policy (Phase 6.3.3)
        // The client's `model` field is a *preference at best*. Whether it is
        // honoured is decided entirely by server configuration.
        const providerDef = getProviderDefinition(config.provider);
        const policy = resolveModelPolicy({
            clientModel: validation.sanitized.model,
            provider: config.provider,
            serverModel: config.model,
            allowedModels: config.allowedModels,
            allowClientModel: config.allowClientModel,
            providerDefaultModel: providerDef?.defaultModel || null
        });

        if (!policy.authorized) {
            return sendError(res, 403, ERROR_CODES.MODEL_NOT_ALLOWED, policy.reason);
        }

        // 11. Upstream AI Provider Dispatch
        try {
            // `model` here is the SERVER-resolved model, never the raw client value.
            const result = await dispatchToProvider(
                { ...validation.sanitized, model: policy.model },
                config
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            const status = err.statusCode || 502;
            const code = err.code || ERROR_CODES.PROVIDER_UNAVAILABLE;
            const message = err.clientMessage || 'AI provider request failed';
            return sendError(res, status, code, message);
        }
    });

    req.on('error', () => {
        if (!res.headersSent) {
            sendError(res, 400, ERROR_CODES.BAD_REQUEST, 'Client request stream error');
        }
    });
}

// ==================================================================
// Payload Validation (Strict Whitelisting - Anti-SSRF)
// ==================================================================

function validateClientPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, error: 'Request body must be a JSON object' };
    }

    // Prompt validation
    if (typeof payload.prompt !== 'string' || payload.prompt.trim().length === 0) {
        return { valid: false, error: 'Field "prompt" is required and must be a non-empty string' };
    }

    if (payload.prompt.length > 10000) {
        return { valid: false, error: 'Field "prompt" exceeds maximum length of 10,000 characters' };
    }

    // Response format validation
    let responseFormat = 'json';
    if (payload.responseFormat !== undefined) {
        if (!['json', 'plan', 'text'].includes(payload.responseFormat)) {
            return { valid: false, error: 'Field "responseFormat" must be one of: "json", "plan", "text"' };
        }
        responseFormat = payload.responseFormat;
    }

    // Temperature validation
    let temperature = 0.2;
    if (payload.temperature !== undefined) {
        if (typeof payload.temperature !== 'number' || isNaN(payload.temperature) || payload.temperature < 0 || payload.temperature > 2) {
            return { valid: false, error: 'Field "temperature" must be a number between 0 and 2' };
        }
        temperature = payload.temperature;
    }

    // Model validation (optional client PREFERENCE, sanitized string only).
    // Being well-formed is necessary but NOT sufficient: whether this value
    // may ever be used is decided by resolveModelPolicy() from server config.
    let model = null;
    if (payload.model !== undefined && payload.model !== null) {
        if (typeof payload.model !== 'string' || !MODEL_ID_PATTERN.test(payload.model)) {
            return { valid: false, error: 'Field "model" contains invalid characters' };
        }
        model = payload.model;
    }

    // Reject any attempt to provide arbitrary upstream URLs, headers or
    // credentials. Compared case-insensitively so `Authorization`,
    // `AUTHORIZATION`, `ApiKey`, ... are all refused identically.
    for (const key of Object.keys(payload)) {
        const normalizedKey = String(key).trim().toLowerCase();
        if (FORBIDDEN_CLIENT_KEYS.includes(normalizedKey)) {
            return { valid: false, error: `Client-controlled "${key}" is prohibited` };
        }
    }

    return {
        valid: true,
        sanitized: {
            prompt: payload.prompt.trim(),
            responseFormat,
            temperature,
            model
        }
    };
}

// ==================================================================
// Phase 6.3.3 — Server-Authoritative Policy (pure, unit-testable)
// ==================================================================

/**
 * Safe own-property lookup into the fixed provider map.
 *
 * Uses hasOwnProperty rather than plain indexing so that a provider string
 * such as `constructor`, `__proto__` or `toString` can never resolve to an
 * inherited Object.prototype member and be mistaken for a provider.
 */
function getProviderDefinition(providerKey) {
    const key = String(providerKey || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(PROVIDER_CONFIG, key)) return null;
    return PROVIDER_CONFIG[key];
}

/**
 * Decide which model an upstream request will actually use.
 *
 * Precedence (server wins, always):
 *   1. `AI_MODEL` configured           → authoritative, client ignored
 *   2. client model + `AI_ALLOW_CLIENT_MODEL` + present in `AI_ALLOWED_MODELS`
 *                                      → accepted (explicit opt-in policy)
 *   3. anything else                   → provider safe default
 *
 * A client model that is not allowlisted is REJECTED (403) rather than
 * silently swapped, so a caller cannot probe which models a deployment has.
 * A client model is never forwarded upstream without server policy.
 *
 * @returns {{ model: string, source: string, authorized: boolean, reason?: string }}
 */
export function resolveModelPolicy({
    clientModel = null,
    provider = 'mock',
    serverModel = null,
    allowedModels = [],
    allowClientModel = false,
    providerDefaultModel = null
} = {}) {
    const providerDef = providerDefaultModel
        ? { defaultModel: providerDefaultModel }
        : getProviderDefinition(provider);
    const providerDefault = providerDef?.defaultModel || PROVIDER_CONFIG.mock.defaultModel;

    const cleanServerModel = typeof serverModel === 'string' && MODEL_ID_PATTERN.test(serverModel.trim())
        ? serverModel.trim()
        : null;

    // 1. Server-configured model is authoritative.
    if (cleanServerModel) {
        return { model: cleanServerModel, source: MODEL_SOURCE.SERVER, authorized: true };
    }

    const cleanClientModel = typeof clientModel === 'string' && clientModel.trim().length > 0
        ? clientModel.trim()
        : null;

    // 2. No client preference at all → provider default.
    if (!cleanClientModel) {
        return { model: providerDefault, source: MODEL_SOURCE.PROVIDER_DEFAULT, authorized: true };
    }

    // 3. Client asked for a specific model. Both gates must be open.
    const allowlist = Array.isArray(allowedModels) ? allowedModels : [];

    if (!allowClientModel) {
        return {
            model: providerDefault,
            source: MODEL_SOURCE.PROVIDER_DEFAULT,
            authorized: false,
            reason: 'Model selection is controlled by the server. Client-supplied models are not accepted by this gateway.'
        };
    }

    if (allowlist.length === 0) {
        return {
            model: providerDefault,
            source: MODEL_SOURCE.PROVIDER_DEFAULT,
            authorized: false,
            reason: 'No server-side model allowlist is configured, so client model selection is refused.'
        };
    }

    if (!allowlist.includes(cleanClientModel)) {
        return {
            model: providerDefault,
            source: MODEL_SOURCE.PROVIDER_DEFAULT,
            authorized: false,
            reason: 'The requested model is not in the server-side allowlist.'
        };
    }

    return { model: cleanClientModel, source: MODEL_SOURCE.CLIENT_ALLOWED, authorized: true };
}

/**
 * Resolve the fixed upstream destination for a provider.
 *
 * The returned URL is derived ONLY from the server-side provider map (plus
 * validated server-side overrides). No argument of this function — and no
 * request field — can alter the hostname, port or path.
 */
export function resolveUpstreamTarget(providerKey, config = {}) {
    const key = String(providerKey || '').toLowerCase();
    const providerDef = getProviderDefinition(key);

    if (!providerDef) {
        const err = new Error(`Unsupported AI provider requested: "${key}"`);
        err.statusCode = 500;
        err.code = ERROR_CODES.PROVIDER_NOT_SUPPORTED;
        // The raw value is a server config value, not client input, but it is
        // still kept out of the client-facing message.
        err.clientMessage = 'The configured AI provider is not supported by this gateway.';
        throw err;
    }

    if (!providerDef.endpoint) {
        const err = new Error(`Provider "${key}" has no upstream endpoint (offline provider)`);
        err.statusCode = 400;
        err.code = ERROR_CODES.BAD_REQUEST;
        err.clientMessage = 'The configured AI provider has no upstream endpoint.';
        throw err;
    }

    // Server-side override (constructor/env only) for the FIXED provider map.
    const overrides = config.providerEndpoints;
    if (overrides && typeof overrides === 'object' && typeof overrides[key] === 'string') {
        return overrides[key];
    }

    if (key === 'ollama') {
        const rawHost = typeof config.ollamaHost === 'string' && config.ollamaHost.trim()
            ? config.ollamaHost.trim()
            : PROVIDER_CONFIG.ollama.endpoint;
        const base = rawHost.replace(/\/+$/, '');
        return `${base}/v1/chat/completions`;
    }

    return providerDef.endpoint;
}

/** Resolve the server-side credential for a provider, or null. */
function resolveProviderApiKey(providerKey, config) {
    const key = String(providerKey || '').toLowerCase();
    if (key === 'groq') return config.groqApiKey || config.apiKey || null;
    if (key === 'openrouter') return config.openrouterApiKey || config.apiKey || null;
    // Generic fallback for any keyed provider added later.
    if (KEYED_PROVIDERS.includes(key)) return config.apiKey || null;
    return null;
}

/** Does the active provider have usable credentials? (health check only) */
function hasProviderCredentials(config) {
    const key = String(config.provider || '').toLowerCase();
    const providerDef = getProviderDefinition(key);
    if (!providerDef) return false;
    if (!providerDef.apiKeyEnv) return true; // mock / ollama need no key
    return Boolean(resolveProviderApiKey(key, config));
}

// ==================================================================
// Upstream Provider Dispatcher
// ==================================================================

async function dispatchToProvider(requestData, config) {
    const providerKey = String(config.provider || '').toLowerCase();

    // 1. Provider allowlist gate (server-controlled selection only).
    const providerDef = getProviderDefinition(providerKey);
    if (!providerDef) {
        const err = new Error(`Unsupported AI provider configured: "${providerKey}"`);
        err.statusCode = 500;
        err.code = ERROR_CODES.PROVIDER_NOT_SUPPORTED;
        err.clientMessage = 'The configured AI provider is not supported by this gateway.';
        throw err;
    }

    // 2. Mock Provider / Custom Test Handler (no credentials required).
    if (providerKey === 'mock') {
        if (typeof config.mockHandler === 'function') {
            return config.mockHandler(requestData);
        }
        return executeDeterministicMock(requestData);
    }

    // 3. Resolve API Key — SERVER-SIDE ONLY.
    const apiKey = resolveProviderApiKey(providerKey, config);
    if (providerDef.apiKeyEnv && !apiKey) {
        const err = new Error(`Missing API key for provider "${providerKey}"`);
        err.statusCode = 503;
        err.code = ERROR_CODES.PROVIDER_UNAVAILABLE;
        // Names the missing VARIABLE, never a value.
        err.clientMessage = `AI provider "${providerKey}" is not configured on the server (missing ${providerDef.apiKeyEnv})`;
        throw err;
    }

    // 4. Resolve Target Model & Endpoint.
    // requestData.model has ALREADY been authorized by resolveModelPolicy();
    // it is never taken raw from the client here.
    const endpoint = resolveUpstreamTarget(providerKey, config);
    const targetModel = requestData.model || providerDef.defaultModel;

    // 5. Construct Standard OpenAI-Compatible Payload
    const upstreamPayload = {
        model: targetModel,
        messages: [
            { role: 'user', content: requestData.prompt }
        ],
        temperature: requestData.temperature,
        max_tokens: config.upstreamMaxTokens || DEFAULT_UPSTREAM_MAX_TOKENS
    };

    if (requestData.responseFormat !== 'text') {
        upstreamPayload.response_format = { type: 'json_object' };
    }

    const payloadBuffer = Buffer.from(JSON.stringify(upstreamPayload), 'utf8');

    // 6. Dispatch HTTP/HTTPS Request
    const targetUrl = new URL(endpoint);
    const isHttps = targetUrl.protocol === 'https:';
    const httpLib = isHttps ? https : http;

    // Authorization is constructed EXCLUSIVELY from server-side credentials.
    // It is never read from the request, never logged and never returned.
    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': payloadBuffer.length,
        'User-Agent': 'ALICE0-Local-Gateway/0.6.0'
    };

    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    if (providerKey === 'openrouter') {
        headers['HTTP-Referer'] = 'http://localhost:3000';
        headers['X-Title'] = 'ALICE0';
    }

    return new Promise((resolve, reject) => {
        const reqOpts = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (isHttps ? 443 : 80),
            path: `${targetUrl.pathname}${targetUrl.search}`,
            method: 'POST',
            headers,
            timeout: config.upstreamTimeoutMs
        };

        const upstreamReq = httpLib.request(reqOpts, (upstreamRes) => {
            const chunks = [];
            let totalBytes = 0;
            let overflowed = false;
            const maxBytes = config.maxUpstreamResponseBytes || 1024 * 1024;

            upstreamRes.on('data', chunk => {
                if (overflowed) return;
                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    // Abandon the stream instead of buffering it in full.
                    overflowed = true;
                    chunks.length = 0;
                    upstreamRes.destroy();
                    reject(upstreamError({
                        statusCode: 502,
                        code: ERROR_CODES.PROVIDER_MALFORMED,
                        clientMessage: `Upstream AI provider response exceeded the ${maxBytes} byte limit`
                    }));
                    return;
                }
                chunks.push(chunk);
            });

            upstreamRes.on('end', () => {
                if (overflowed) return;

                const status = upstreamRes.statusCode;

                // ---- Non-2xx: normalized, provider-detail-free -------------
                if (typeof status !== 'number' || status < 200 || status >= 300) {
                    return reject(normalizeUpstreamStatus(status, upstreamRes.headers));
                }

                // ---- 2xx: STRICT normalization ----------------------------
                // A malformed or empty provider response is an ERROR. It is
                // never converted into a successful empty completion.
                let normalized;
                try {
                    normalized = normalizeProviderResponse(Buffer.concat(chunks).toString('utf8'));
                } catch (normErr) {
                    return reject(upstreamError({
                        statusCode: 502,
                        code: ERROR_CODES.PROVIDER_MALFORMED,
                        clientMessage: normErr.clientMessage
                    }));
                }

                resolve({
                    // The server credential is scrubbed out of model output
                    // before it can reach the client: a provider that echoes
                    // our own Authorization header must not turn into a key
                    // exfiltration channel into the browser.
                    text: redactSecrets(normalized.text, [apiKey]),
                    usage: normalized.usage,
                    // Which model actually served the request (server policy).
                    model: targetModel
                });
            });

            upstreamRes.on('error', () => {
                reject(upstreamError({
                    statusCode: 502,
                    code: ERROR_CODES.PROVIDER_UNAVAILABLE,
                    clientMessage: 'Unable to read the upstream AI provider response'
                }));
            });
        });

        upstreamReq.on('timeout', () => {
            upstreamReq.destroy();
            reject(upstreamError({
                statusCode: 504,
                code: ERROR_CODES.PROVIDER_TIMEOUT,
                clientMessage: `AI provider request timed out after ${config.upstreamTimeoutMs}ms`
            }));
        });

        upstreamReq.on('error', () => {
            // The raw OS error can contain hostnames/ports; it is logged
            // nowhere and never surfaced. No retry is ever attempted.
            reject(upstreamError({
                statusCode: 502,
                code: ERROR_CODES.PROVIDER_UNAVAILABLE,
                clientMessage: 'Unable to reach upstream AI provider'
            }));
        });

        upstreamReq.write(payloadBuffer);
        upstreamReq.end();
    });
}

// ==================================================================
// Phase 6.3.3 — Response Normalization & Error Mapping
// ==================================================================

/**
 * Build a gateway error carrying a safe, client-facing message.
 * `internalMessage` stays on the server object and is NEVER serialized into
 * a response body.
 */
function upstreamError({ statusCode, code, clientMessage, internalMessage = '' }) {
    const err = new Error(internalMessage || clientMessage);
    err.statusCode = statusCode;
    err.code = code;
    err.clientMessage = clientMessage;
    return err;
}

/**
 * Map an upstream HTTP status onto a normalized gateway error.
 *
 * Category-preserving (a provider 401/403/429 stays distinguishable) but
 * content-free: upstream bodies, headers and endpoints are discarded so no
 * provider detail or credential can reach the client.
 */
export function normalizeUpstreamStatus(status, upstreamHeaders = {}) {
    const code = typeof status === 'number' ? status : 0;

    if (code === 401) {
        return upstreamError({
            statusCode: 401,
            code: ERROR_CODES.UNAUTHORIZED,
            clientMessage: 'The configured AI provider rejected the server credentials.'
        });
    }
    if (code === 403) {
        return upstreamError({
            statusCode: 403,
            code: ERROR_CODES.UNAUTHORIZED,
            clientMessage: 'The configured AI provider refused this request.'
        });
    }
    if (code === 429) {
        const err = upstreamError({
            statusCode: 429,
            code: ERROR_CODES.RATE_LIMITED,
            clientMessage: 'Upstream AI provider rate limit reached. Please wait a moment.'
        });
        // Only the numeric hint is carried over, never provider prose.
        const retryAfter = readUpstreamHeader(upstreamHeaders, 'retry-after');
        if (retryAfter && /^\d{1,7}$/.test(retryAfter)) err.retryAfter = retryAfter;
        return err;
    }
    if (code >= 500) {
        return upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_UNAVAILABLE,
            clientMessage: `Upstream AI provider error (HTTP ${code})`
        });
    }
    if (code >= 400) {
        return upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_UNAVAILABLE,
            clientMessage: `Upstream AI provider rejected the request (HTTP ${code})`
        });
    }
    return upstreamError({
        statusCode: 502,
        code: ERROR_CODES.PROVIDER_UNAVAILABLE,
        clientMessage: 'Upstream AI provider returned an unexpected response'
    });
}

/** Case-insensitive header read for the small set of headers we act on. */
function readUpstreamHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return null;
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
    const value = key ? headers[key] : null;
    return typeof value === 'string' ? value.trim() : null;
}

/**
 * STRICTLY normalize an OpenAI-compatible provider response.
 *
 * Every one of these is an error, never an empty success:
 *   - non-JSON / malformed JSON
 *   - non-object body
 *   - missing `choices`
 *   - empty `choices` / missing first choice
 *   - missing `message`
 *   - missing or non-string `content`
 *   - empty / whitespace-only content
 *
 * Returns only `{ text, usage }` — nothing else from the provider payload is
 * forwarded. The text remains UNTRUSTED: the gateway never parses it as a
 * plan and never executes it.
 *
 * @throws {Error & { clientMessage: string }}
 */
export function normalizeProviderResponse(rawBody) {
    if (typeof rawBody !== 'string' || rawBody.trim().length === 0) {
        throw upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_MALFORMED,
            clientMessage: 'Upstream AI provider returned an empty response'
        });
    }

    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch (e) {
        throw upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_MALFORMED,
            clientMessage: 'Upstream AI provider returned malformed JSON'
        });
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_MALFORMED,
            clientMessage: 'Upstream AI provider returned an unexpected response shape'
        });
    }

    // Some OpenAI-compatible servers (Ollama /v1) may return `response`.
    // It is accepted ONLY when the chat-completions shape is absent.
    if (payload.choices === undefined && typeof payload.response === 'string') {
        if (payload.response.trim().length === 0) {
            throw upstreamError({
                statusCode: 502,
                code: ERROR_CODES.PROVIDER_MALFORMED,
                clientMessage: 'Upstream AI provider returned an empty response'
            });
        }
        return { text: payload.response, usage: normalizeUsage(payload.usage) };
    }

    if (!Array.isArray(payload.choices)) {
        throw upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_MALFORMED,
            clientMessage: 'Upstream AI provider response is missing "choices"'
        });
    }
    if (payload.choices.length === 0) {
        throw upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_MALFORMED,
            clientMessage: 'Upstream AI provider returned no completion choices'
        });
    }

    const firstChoice = payload.choices[0];
    if (!firstChoice || typeof firstChoice !== 'object' || Array.isArray(firstChoice)) {
        throw upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_MALFORMED,
            clientMessage: 'Upstream AI provider response is missing a valid first choice'
        });
    }

    const message = firstChoice.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_MALFORMED,
            clientMessage: 'Upstream AI provider response is missing "message"'
        });
    }

    const content = message.content;
    if (typeof content !== 'string') {
        throw upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_MALFORMED,
            clientMessage: 'Upstream AI provider response is missing message content'
        });
    }
    if (content.trim().length === 0) {
        throw upstreamError({
            statusCode: 502,
            code: ERROR_CODES.PROVIDER_MALFORMED,
            clientMessage: 'Upstream AI provider returned an empty model response'
        });
    }

    return { text: content, usage: normalizeUsage(payload.usage) };
}

/** Reduce an untrusted usage block to three optional finite numbers. */
function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;

    const pick = names => {
        for (const name of names) {
            const value = usage[name];
            if (typeof value === 'number' && Number.isFinite(value)) return value;
        }
        return undefined;
    };

    const normalized = {};
    const promptTokens = pick(['prompt_tokens', 'promptTokens', 'input_tokens']);
    const completionTokens = pick(['completion_tokens', 'completionTokens', 'output_tokens']);
    const totalTokens = pick(['total_tokens', 'totalTokens']);

    if (promptTokens !== undefined) normalized.promptTokens = promptTokens;
    if (completionTokens !== undefined) normalized.completionTokens = completionTokens;
    if (totalTokens !== undefined) normalized.totalTokens = totalTokens;

    return Object.keys(normalized).length > 0 ? normalized : null;
}

// ==================================================================
// Phase 6.3.3 — Secret-Safe Logging
// ==================================================================

/**
 * Redact anything credential-shaped from a value destined for a log.
 *
 * The gateway never logs upstream headers, request bodies or provider
 * responses; this is defence-in-depth for the few things it does log.
 */
export function sanitizeForLog(input) {
    if (input === null || input === undefined) return '';
    let text;
    try {
        text = typeof input === 'string' ? input : JSON.stringify(input);
    } catch (e) {
        text = String(input);
    }
    if (typeof text !== 'string') return '';

    return text
        .replace(/(authorization["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
        .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
        // Common provider key shapes: sk-…, gsk_…, pk-…, rk_…, hf_…, or-…
        .replace(/\b(?:sk|gsk|pk|rk|hf|or)[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
        .replace(/\b[0-9a-f]{32,}\b/gi, '[REDACTED_TOKEN]');
}

/**
 * Remove known secret VALUES from text that is about to leave the gateway.
 *
 * This is a last-line defence, not the primary control: the gateway never
 * puts a credential into a response in the first place. It exists because the
 * upstream response body is attacker-influenced (a provider — or anything
 * impersonating one — can echo the request's Authorization header back), and
 * model output is forwarded to the browser as untrusted data.
 *
 * Both the bare value and its `Bearer <value>` form are scrubbed.
 */
export function redactSecrets(text, secrets = []) {
    if (typeof text !== 'string' || text.length === 0) return text;

    let out = text;
    for (const secret of secrets) {
        if (typeof secret !== 'string' || secret.length < 8) continue;
        // Literal replacement (split/join) — the secret is never compiled
        // into a RegExp, so metacharacters in a key cannot alter matching.
        out = out.split(`Bearer ${secret}`).join('Bearer [REDACTED]');
        out = out.split(secret).join('[REDACTED]');
    }
    return out;
}

// ==================================================================
// Deterministic Mock Generator (Zero Network / Test Safe)
// ==================================================================

function executeDeterministicMock(requestData) {
    const prompt = requestData.prompt;
    // Same normalized envelope as the real path, so the HttpModelAdapter
    // contract is identical in mock and live mode.
    const model = requestData.model || PROVIDER_CONFIG.mock.defaultModel;

    // Check for multi-step recipes
    if (/research/i.test(prompt) && /summar/i.test(prompt) && /doc/i.test(prompt)) {
        const topicMatch = prompt.match(/research\s+([^,]+)/i);
        const topic = topicMatch ? topicMatch[1].trim() : 'topic';
        const plan = {
            goal: prompt,
            steps: [
                { id: 'step_1', skill: 'websearch', action: 'search', input: topic, contextKey: 'research', dependsOn: [] },
                { id: 'step_2', skill: 'core', operation: 'summarize', input: '', inputSource: 'research', contextKey: 'summary', dependsOn: ['step_1'] },
                { id: 'step_3', skill: 'files', action: 'create', input: '', inputSource: 'summary', contextKey: 'document', filename: 'alice-research.txt', dependsOn: ['step_2'] }
            ]
        };
        return { text: JSON.stringify(plan), usage: null, model };
    }

    if (requestData.responseFormat === 'text') {
        return { text: `Processed request for: "${prompt}"`, usage: null, model };
    }

    return {
        text: JSON.stringify({ type: 'response', response: `Understood: "${prompt}"` }),
        usage: null,
        model
    };
}

// ==================================================================
// Helpers
// ==================================================================

function sendError(res, statusCode, code, message) {
    if (res.headersSent) return;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        error: {
            code,
            message
        }
    }));
}

function getClientIp(req) {
    const directIp = req.socket.remoteAddress || '';
    return directIp;
}

function isLocalAddress(ip) {
    if (!ip) return false;
    return (
        ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip === 'localhost' ||
        ip.startsWith('127.')
    );
}

// ==================================================================
// CLI Server Starter
// ==================================================================

export function startGatewayServer(customConfig = {}) {
    const server = createGatewayServer(customConfig);
    const port = Number(customConfig.port || process.env.GATEWAY_PORT || process.env.PORT || 3001);
    const host = customConfig.host || process.env.GATEWAY_HOST || '127.0.0.1';
    const config = server.aliceConfig;

    server.listen(port, host, () => {
        // Only non-sensitive operational facts are ever logged. The provider
        // is confirmed against the allowlist, and no credential, header or
        // endpoint value is written to the console.
        const provider = SUPPORTED_PROVIDERS.includes(config.provider) ? config.provider : 'unsupported';
        const effectiveModel = resolveModelPolicy({
            clientModel: null,
            provider: config.provider,
            serverModel: config.model,
            allowedModels: config.allowedModels,
            allowClientModel: config.allowClientModel
        }).model;

        console.log(sanitizeForLog(`[ALICE0 Gateway] Secure Local AI Gateway listening on http://${host}:${port}`));
        console.log(sanitizeForLog(`[ALICE0 Gateway] Active Provider: ${provider}`));
        console.log(sanitizeForLog(`[ALICE0 Gateway] Active Model: ${effectiveModel}`));
        console.log(sanitizeForLog(`[ALICE0 Gateway] Credentials configured: ${hasProviderCredentials(config)}`));
        console.log(sanitizeForLog(`[ALICE0 Gateway] Client model selection: ${config.allowClientModel ? 'allowed (allowlisted only)' : 'disabled'}`));
    });

    return server;
}

// Run directly if invoked from CLI
if (process.argv[1] && process.argv[1].endsWith('gateway.js')) {
    startGatewayServer();
}
