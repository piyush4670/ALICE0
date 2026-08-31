/**
 * ALICE0 Secure Local AI Gateway (Phase 6.3.1)
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
        ollamaHost: customConfig.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434',
        allowedOrigins: customConfig.allowedOrigins || (process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
            : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://localhost:3001', 'http://127.0.0.1:3001']),
        rateLimitPerMinute: Number(customConfig.rateLimitPerMinute || process.env.RATE_LIMIT_PER_MINUTE || 20),
        maxBodySize: Number(customConfig.maxBodySize || 32768), // 32 KB
        upstreamTimeoutMs: Number(customConfig.upstreamTimeoutMs || 10000), // 10s
        localTrustToken: customConfig.localTrustToken || process.env.LOCAL_TRUST_TOKEN || null,
        mockHandler: customConfig.mockHandler || null // for testing
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

    return server;
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            provider: config.provider,
            model: config.model || PROVIDER_CONFIG[config.provider]?.defaultModel || 'default'
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

        // 10. Upstream AI Provider Dispatch
        try {
            const result = await dispatchToProvider(validation.sanitized, config);
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

    // Model validation (optional client preference, sanitized string only)
    let model = null;
    if (payload.model !== undefined && payload.model !== null) {
        if (typeof payload.model !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(payload.model)) {
            return { valid: false, error: 'Field "model" contains invalid characters' };
        }
        model = payload.model;
    }

    // Reject any attempt to provide arbitrary upstream URLs or authorization headers
    const forbiddenKeys = ['url', 'targetUrl', 'endpoint', 'destination', 'host', 'port', 'headers', 'authorization', 'auth', 'apiKey'];
    for (const key of Object.keys(payload)) {
        if (forbiddenKeys.includes(key)) {
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
// Upstream Provider Dispatcher
// ==================================================================

async function dispatchToProvider(requestData, config) {
    const providerKey = config.provider;

    // 1. Mock Provider / Custom Test Handler
    if (providerKey === 'mock') {
        if (typeof config.mockHandler === 'function') {
            return config.mockHandler(requestData);
        }
        return executeDeterministicMock(requestData);
    }

    // 2. Resolve Upstream Provider Config
    const provDef = PROVIDER_CONFIG[providerKey];
    if (!provDef) {
        const err = new Error(`Unsupported AI provider: "${providerKey}"`);
        err.statusCode = 500;
        err.code = ERROR_CODES.GATEWAY_ERROR;
        err.clientMessage = `Configured AI provider "${providerKey}" is not supported`;
        throw err;
    }

    // 3. Resolve API Key
    let apiKey = null;
    if (providerKey === 'groq') apiKey = config.groqApiKey;
    else if (providerKey === 'openrouter') apiKey = config.openrouterApiKey;

    if (provDef.apiKeyEnv && !apiKey) {
        const err = new Error(`Missing API key for provider "${providerKey}"`);
        err.statusCode = 503;
        err.code = ERROR_CODES.PROVIDER_UNAVAILABLE;
        err.clientMessage = `AI provider "${providerKey}" is not configured on the server (missing ${provDef.apiKeyEnv})`;
        throw err;
    }

    // 4. Resolve Target Model & Endpoint
    let endpoint = provDef.endpoint;
    if (providerKey === 'ollama') {
        endpoint = `${config.ollamaHost.replace(/\/+$/, '')}/v1/chat/completions`;
    }

    const targetModel = config.model || requestData.model || provDef.defaultModel;

    // 5. Construct Standard OpenAI-Compatible Payload
    const upstreamPayload = {
        model: targetModel,
        messages: [
            { role: 'user', content: requestData.prompt }
        ],
        temperature: requestData.temperature,
        max_tokens: 1024
    };

    if (requestData.responseFormat !== 'text') {
        upstreamPayload.response_format = { type: 'json_object' };
    }

    const payloadBuffer = Buffer.from(JSON.stringify(upstreamPayload), 'utf8');

    // 6. Dispatch HTTP/HTTPS Request
    const targetUrl = new URL(endpoint);
    const isHttps = targetUrl.protocol === 'https:';
    const httpLib = isHttps ? https : http;

    const headers = {
        'Content-Type': 'application/json',
        'Content-Length': payloadBuffer.length,
        'User-Agent': 'ALICE0-Local-Gateway/0.5.0'
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
            let resBody = '';
            upstreamRes.on('data', chunk => { resBody += chunk; });
            upstreamRes.on('end', () => {
                const status = upstreamRes.statusCode;

                if (status < 200 || status >= 300) {
                    const err = new Error(`Upstream provider returned HTTP ${status}`);
                    err.statusCode = status === 429 ? 429 : 502;
                    err.code = status === 429 ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.PROVIDER_UNAVAILABLE;
                    err.clientMessage = status === 429
                        ? 'Upstream AI provider rate limit reached. Please wait a moment.'
                        : `Upstream AI provider error (HTTP ${status})`;
                    return reject(err);
                }

                try {
                    const parsedData = JSON.parse(resBody);
                    const text = parsedData.choices?.[0]?.message?.content || parsedData.response || '';
                    const usage = parsedData.usage || null;

                    resolve({
                        text,
                        usage
                    });
                } catch (jsonErr) {
                    const err = new Error('Failed to parse upstream provider response as JSON');
                    err.statusCode = 502;
                    err.code = ERROR_CODES.PROVIDER_UNAVAILABLE;
                    err.clientMessage = 'Upstream AI provider returned malformed response';
                    reject(err);
                }
            });
        });

        upstreamReq.on('timeout', () => {
            upstreamReq.destroy();
            const err = new Error('Upstream provider timed out');
            err.statusCode = 504;
            err.code = ERROR_CODES.PROVIDER_TIMEOUT;
            err.clientMessage = `AI provider request timed out after ${config.upstreamTimeoutMs}ms`;
            reject(err);
        });

        upstreamReq.on('error', (netErr) => {
            const err = new Error(`Upstream network connection error: ${netErr.message}`);
            err.statusCode = 502;
            err.code = ERROR_CODES.PROVIDER_UNAVAILABLE;
            err.clientMessage = 'Unable to reach upstream AI provider';
            reject(err);
        });

        upstreamReq.write(payloadBuffer);
        upstreamReq.end();
    });
}

// ==================================================================
// Deterministic Mock Generator (Zero Network / Test Safe)
// ==================================================================

function executeDeterministicMock(requestData) {
    const prompt = requestData.prompt;

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
        return { text: JSON.stringify(plan), usage: null };
    }

    if (requestData.responseFormat === 'text') {
        return { text: `Processed request for: "${prompt}"`, usage: null };
    }

    return {
        text: JSON.stringify({ type: 'response', response: `Understood: "${prompt}"` }),
        usage: null
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

    server.listen(port, host, () => {
        console.log(`[ALICE0 Gateway] Secure Local AI Gateway listening on http://${host}:${port}`);
        console.log(`[ALICE0 Gateway] Active Provider: ${process.env.AI_PROVIDER || 'mock'}`);
    });

    return server;
}

// Run directly if invoked from CLI
if (process.argv[1] && process.argv[1].endsWith('gateway.js')) {
    startGatewayServer();
}
