/**
 * ALICE HTTP Model Adapter (Phase 6.3.2)
 * ------------------------------------------------------------------
 * Real, transport-level ModelAdapter implementation. It speaks ONE
 * protocol to ONE destination: the ALICE0 local secure gateway.
 *
 *     AI Brain
 *        ↓
 *     HttpModelAdapter
 *        ↓  POST http://127.0.0.1:<gateway-port>/api/ai/generate
 *     Secure Gateway (server/gateway.js — credential boundary)
 *        ↓  (provider credentials injected server-side)
 *     Configured AI Provider
 *
 * What this adapter may NEVER do:
 *   - contact Groq / OpenAI / Gemini / OpenRouter / Ollama directly
 *   - hold, read or forward a provider API key
 *   - read credentials from localStorage / sessionStorage
 *   - send an `Authorization` header of any kind
 *   - accept a caller-supplied upstream URL, host, or header set
 *   - retry aggressively (retry policy is a deliberate later phase)
 *
 * What this adapter ALWAYS does:
 *   - resolves its destination from runtime configuration only
 *   - sends a minimal, whitelisted request body
 *   - enforces a client-side timeout, AbortSignal cancellation and a
 *     maximum response size
 *   - validates and normalizes the gateway response before returning
 *   - normalizes every failure into the existing AI error hierarchy
 *     (js/ai/modelAdapter.js — no duplicated error classes)
 *
 * Model output returned by this adapter is UNTRUSTED DATA. It still has to
 * pass through PlanValidator before anything is executed.
 */
import { CONFIG } from '../config.js';
import { redact } from '../utils.js';
import {
    ModelAdapter,
    AIValidationError,
    AIProviderError,
    AITimeoutError,
    AICancellationError
} from './modelAdapter.js';

// ==================================================================
// Constants
// ==================================================================

/** Default same-origin gateway path used when only an origin is configured. */
export const GATEWAY_DEFAULT_PATH = '/api/ai/generate';

/** Response formats accepted by the gateway contract (Phase 6.3.1). */
const ALLOWED_RESPONSE_FORMATS = ['json', 'plan', 'text'];

/** Formats whose payload is expected to be machine-readable JSON. */
const STRUCTURED_FORMATS = ['json', 'plan'];

/** Model identifier whitelist — mirrors the gateway's own sanitizer. */
const MODEL_ID_PATTERN = /^[a-zA-Z0-9_.:/-]{1,100}$/;

const MAX_GATEWAY_URL_LENGTH = 2048;
const MAX_TRUST_TOKEN_LENGTH = 512;

/** Error bodies are read with a much smaller cap than success bodies. */
const ERROR_BODY_LIMIT_BYTES = 4096;

/** Loopback destinations that are always permitted. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Dangerous object keys rejected during structured-output validation. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_STRUCTURED_DEPTH = 8;
const MAX_STRUCTURED_KEYS = 200;

/**
 * Transport failure codes mapped to safe, human-readable messages.
 * The raw OS error (and any provider detail) is never surfaced verbatim.
 */
const NETWORK_CAUSE_MESSAGES = {
    ECONNREFUSED: 'The ALICE AI gateway refused the connection. Make sure the local gateway is running.',
    ECONNRESET: 'The connection to the ALICE AI gateway was reset.',
    ENOTFOUND: 'The ALICE AI gateway host could not be resolved.',
    EAI_AGAIN: 'The ALICE AI gateway host could not be resolved.',
    ETIMEDOUT: 'The connection to the ALICE AI gateway timed out.',
    EPIPE: 'The connection to the ALICE AI gateway was interrupted.',
    EHOSTUNREACH: 'The ALICE AI gateway host is unreachable.',
    ENETUNREACH: 'The network is unreachable.',
    UND_ERR_SOCKET: 'The connection to the ALICE AI gateway failed.',
    UND_ERR_CONNECT_TIMEOUT: 'The connection to the ALICE AI gateway timed out.',
    UND_ERR_HEADERS_TIMEOUT: 'The ALICE AI gateway did not respond in time.',
    UND_ERR_BODY_TIMEOUT: 'The ALICE AI gateway stopped responding.'
};

/** Fallback messages for HTTP statuses (used when the gateway sends none). */
const DEFAULT_STATUS_MESSAGES = {
    0: 'The ALICE AI gateway did not return a valid HTTP response.',
    400: 'The ALICE AI gateway rejected the request.',
    401: 'The ALICE AI gateway rejected the local trust token.',
    403: 'The ALICE AI gateway refused this request.',
    404: 'The ALICE AI gateway endpoint was not found.',
    405: 'The ALICE AI gateway does not allow this request method.',
    408: 'The ALICE AI gateway request timed out.',
    413: 'The request exceeded the ALICE AI gateway payload limit.',
    429: 'The ALICE AI gateway rate limit was reached. Please wait a moment.',
    500: 'The ALICE AI gateway encountered an internal error.',
    502: 'The ALICE AI gateway could not reach the configured AI provider.',
    503: 'The AI provider is not available on the ALICE AI gateway.',
    504: 'The AI provider did not respond through the ALICE AI gateway in time.'
};

// ==================================================================
// Runtime configuration resolution (no credentials, ever)
// ==================================================================

function firstNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

/**
 * Read a server/Node environment variable.
 * Browsers do not define `process`; the failure is swallowed on purpose.
 */
function readEnv(name) {
    try {
        if (typeof process !== 'undefined' && process && process.env) {
            return firstNonEmptyString(process.env[name]);
        }
    } catch (e) {
        /* process is not available (browser bundle) */
    }
    return '';
}

/**
 * Read a value published by the local deployment into the page
 * (e.g. window.ALICE_GATEWAY_URL injected by the local server).
 */
function readGlobal(name) {
    try {
        if (typeof globalThis === 'object' && globalThis[name] != null) {
            return firstNonEmptyString(globalThis[name]);
        }
    } catch (e) {
        /* globalThis unavailable */
    }
    return '';
}

/** Read a value from a document meta tag, if a DOM is present. */
function readMeta(name) {
    try {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return '';
        const el = document.querySelector(`meta[name="${name}"]`);
        return el ? firstNonEmptyString(el.getAttribute?.('content')) : '';
    } catch (e) {
        return '';
    }
}

function readRuntimeValue({ envNames = [], globalNames = [], metaNames = [] }) {
    for (const name of envNames) {
        const value = readEnv(name);
        if (value) return value;
    }
    for (const name of globalNames) {
        const value = readGlobal(name);
        if (value) return value;
    }
    for (const name of metaNames) {
        const value = readMeta(name);
        if (value) return value;
    }
    return '';
}

/**
 * Resolve the gateway URL for this deployment.
 * Order: explicit config ▶ AI_GATEWAY_URL ▶ window.ALICE_GATEWAY_URL ▶
 *        <meta name="alice-gateway-url"> ▶ CONFIG.ai.gateway.url ▶
 *        CONFIG.ai.gateway.path ▶ default same-origin path.
 */
export function resolveGatewayUrl(config = {}) {
    const raw =
        firstNonEmptyString(config.gatewayUrl) ||
        readRuntimeValue({
            envNames: ['AI_GATEWAY_URL', 'ALICE_GATEWAY_URL'],
            globalNames: ['ALICE_GATEWAY_URL'],
            metaNames: ['alice-gateway-url']
        }) ||
        firstNonEmptyString(CONFIG.ai?.gateway?.url) ||
        firstNonEmptyString(CONFIG.ai?.gateway?.path) ||
        GATEWAY_DEFAULT_PATH;

    return normalizeGatewayUrl(raw);
}

/**
 * Validate and normalize a configured gateway URL.
 * Only http(s) absolute URLs aimed at the local gateway, or a same-origin
 * absolute path, are accepted. Provider URLs and exotic schemes are refused.
 */
export function normalizeGatewayUrl(rawUrl) {
    const candidate = firstNonEmptyString(rawUrl);

    if (!candidate) {
        throw new AIValidationError('ALICE gateway URL is not configured');
    }
    if (candidate.length > MAX_GATEWAY_URL_LENGTH) {
        throw new AIValidationError('ALICE gateway URL exceeds the maximum configured length');
    }
    if (candidate.startsWith('//')) {
        throw new AIValidationError('ALICE gateway URL must not be protocol-relative');
    }

    // ---- Absolute URL -------------------------------------------------
    if (candidate.includes('://')) {
        let parsed;
        try {
            parsed = new URL(candidate);
        } catch (e) {
            throw new AIValidationError('ALICE gateway URL is not a valid URL');
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new AIValidationError('ALICE gateway URL must use http or https');
        }
        if (parsed.username || parsed.password) {
            throw new AIValidationError('ALICE gateway URL must not contain credentials');
        }
        if (!isAllowedGatewayHost(parsed.hostname)) {
            throw new AIValidationError(
                `ALICE gateway host "${parsed.hostname}" is not permitted; only the local gateway may be contacted`
            );
        }

        const pathname = !parsed.pathname || parsed.pathname === '/'
            ? firstNonEmptyString(CONFIG.ai?.gateway?.path) || GATEWAY_DEFAULT_PATH
            : parsed.pathname;

        // Query strings and fragments are dropped: the gateway contract is
        // a single fixed path with a JSON body.
        return `${parsed.protocol}//${parsed.host}${pathname}`;
    }

    // ---- Same-origin relative path ------------------------------------
    if (!candidate.startsWith('/')) {
        throw new AIValidationError('ALICE gateway URL must be an absolute http(s) URL or an absolute path');
    }
    if (candidate.includes('..')) {
        throw new AIValidationError('ALICE gateway URL must not contain relative path segments');
    }
    return candidate;
}

function isAllowedGatewayHost(hostname) {
    const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return false;
    if (LOOPBACK_HOSTS.has(host) || LOOPBACK_HOSTS.has(`[${host}]`)) return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;

    const allowed = Array.isArray(CONFIG.ai?.gateway?.allowedHosts) ? CONFIG.ai.gateway.allowedHosts : [];
    return allowed.some(entry => String(entry).trim().toLowerCase() === host);
}

/**
 * Resolve the optional LOCAL trust token for the gateway.
 * This is a deployment-level shared secret for the local loopback gateway,
 * never a provider API key. It may only come from explicit config or the
 * runtime environment — never from browser web storage.
 */
export function resolveGatewayTrustToken(config = {}) {
    const raw =
        firstNonEmptyString(config.trustToken) ||
        readRuntimeValue({
            envNames: ['LOCAL_TRUST_TOKEN', 'ALICE_GATEWAY_TOKEN'],
            globalNames: ['ALICE_GATEWAY_TOKEN'],
            metaNames: ['alice-gateway-token']
        }) ||
        firstNonEmptyString(CONFIG.ai?.gateway?.trustToken);

    if (!raw) return '';
    if (raw.length > MAX_TRUST_TOKEN_LENGTH) {
        throw new AIValidationError('ALICE gateway trust token exceeds the maximum configured length');
    }
    // Header-injection guard: a token may never contain CR/LF or NUL.
    if (/[\r\n\0]/.test(raw)) {
        throw new AIValidationError('ALICE gateway trust token contains invalid characters');
    }
    return raw;
}

// ==================================================================
// Adapter
// ==================================================================

export class HttpModelAdapter extends ModelAdapter {
    /**
     * @param {Object} [config]
     * @param {string} [config.gatewayUrl] - Explicit gateway URL (otherwise resolved at runtime)
     * @param {string} [config.trustToken] - Optional local trust token
     * @param {string} [config.model] - Optional model identifier preference
     * @param {number} [config.timeout] - Request timeout in ms
     * @param {number} [config.maxResponseBytes] - Response body cap in bytes
     * @param {Function} [config.fetchImpl] - Injectable transport (tests / hosts without fetch)
     */
    constructor(config = {}) {
        super(config);
        this._fetchImpl = typeof config.fetchImpl === 'function' ? config.fetchImpl : null;
    }

    // ==================================================================
    // Public surface
    // ==================================================================

    /**
     * The single network destination this adapter is allowed to contact.
     * @returns {string} normalized gateway URL
     */
    getGatewayUrl() {
        return resolveGatewayUrl(this._config);
    }

    /**
     * Build the exact request that will be sent to the gateway.
     * Exposed so tests and host code can audit the outbound contract
     * without performing a network call.
     *
     * @param {string|Object} prompt
     * @param {Object} [options]
     * @param {AbortSignal} [signal]
     * @returns {{ url: string, init: Object, body: Object }}
     */
    buildRequest(prompt, options = {}, signal = null) {
        const body = {
            prompt: this._normalizePrompt(prompt),
            responseFormat: normalizeResponseFormat(options.responseFormat),
            temperature: normalizeTemperature(options.temperature)
        };

        const model = normalizeModel(options.model || this._config.model);
        if (model) body.model = model;

        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json'
        };

        // The only credential-adjacent header ever sent is the optional
        // LOCAL trust token. Never an `Authorization` header, never a
        // provider API key.
        const trustToken = resolveGatewayTrustToken(this._config);
        if (trustToken) {
            headers['X-Local-Trust-Token'] = trustToken;
        }

        return {
            url: resolveGatewayUrl(this._config),
            body,
            init: {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                cache: 'no-store',
                credentials: 'omit',   // no cookies are ever sent to the gateway
                redirect: 'manual',    // redirects must never silently move the destination
                ...(signal ? { signal } : {})
            }
        };
    }

    /**
     * Primary generation entry point.
     *
     * @param {string|Object} prompt - Prompt text or normalized prompt object
     * @param {Object} [options]
     * @param {number} [options.timeout] - Timeout in ms
     * @param {AbortSignal} [options.signal] - Cancellation signal
     * @param {string} [options.responseFormat] - 'json' | 'plan' | 'text'
     * @returns {Promise<{ text: string, structured: Object|null, usage: Object|null }>}
     */
    async generate(prompt, options = {}) {
        const timeoutMs = this._resolveTimeout(options);
        const externalSignal = options.signal || null;

        if (externalSignal && externalSignal.aborted) {
            throw new AICancellationError('AI request was aborted before it started');
        }

        // A single internal controller lets us abort the underlying socket on
        // timeout or external cancellation, so nothing is left hanging.
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const context = { reason: null, timeoutMs };

        const onExternalAbort = () => {
            context.reason = 'external';
            if (controller) controller.abort();
        };

        let timeoutHandle = null;
        timeoutHandle = setTimeout(() => {
            context.reason = context.reason || 'timeout';
            if (controller) controller.abort();
        }, timeoutMs);

        if (externalSignal && typeof externalSignal.addEventListener === 'function') {
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }

        const execution = this._execute(prompt, options, controller ? controller.signal : null)
            .catch(err => {
                throw this._normalizeTransportError(err, context);
            });

        try {
            // withTimeout() guarantees a bounded promise even if the
            // transport ignores its AbortSignal (no hanging promises).
            return await this.withTimeout(execution, timeoutMs, externalSignal);
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
                externalSignal.removeEventListener('abort', onExternalAbort);
            }
        }
    }

    // ==================================================================
    // Transport
    // ==================================================================

    async _execute(prompt, options, signal) {
        const fetchImpl = this._resolveFetch();
        if (typeof fetchImpl !== 'function') {
            throw new AIProviderError('No HTTP transport is available to reach the ALICE gateway');
        }

        const request = this.buildRequest(prompt, options, signal);

        // Network-level failures (connection refused, DNS, socket errors)
        // propagate and are normalized by _normalizeTransportError().
        const response = await fetchImpl(request.url, request.init);

        if (!response || typeof response.status !== 'number') {
            throw new AIValidationError('ALICE gateway returned an invalid HTTP response');
        }

        const status = response.status;

        // Redirects are refused outright: the destination must stay fixed.
        if (status < 200 || status >= 300) {
            const rawError = await this._readLimitedText(response, ERROR_BODY_LIMIT_BYTES);
            throw this._httpError(status, response.headers, rawError);
        }

        const maxResponseBytes = this._resolveMaxResponseBytes();
        const rawBody = await this._readLimitedText(response, maxResponseBytes);

        if (typeof rawBody !== 'string' || rawBody.trim().length === 0) {
            throw new AIValidationError('ALICE gateway returned an empty response');
        }

        const payload = this._safeJsonParse(rawBody);
        return this._normalizeResponse(payload, options);
    }

    _resolveFetch() {
        if (this._fetchImpl) return this._fetchImpl;
        try {
            if (typeof fetch === 'function') return fetch;
        } catch (e) {
            /* fetch not defined */
        }
        try {
            if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
                return globalThis.fetch;
            }
        } catch (e) {
            /* globalThis unavailable */
        }
        return null;
    }

    _resolveTimeout(options = {}) {
        const candidates = [
            Number(options.timeout),
            Number(this._config.timeout),
            Number(CONFIG.ai?.gateway?.timeout),
            Number(CONFIG.ai?.timeout)
        ];
        for (const value of candidates) {
            if (Number.isFinite(value) && value > 0) return Math.floor(value);
        }
        return 5000;
    }

    _resolveMaxResponseBytes() {
        const candidates = [
            Number(this._config.maxResponseBytes),
            Number(CONFIG.ai?.gateway?.maxResponseBytes)
        ];
        for (const value of candidates) {
            if (Number.isFinite(value) && value > 0) return Math.floor(value);
        }
        return 65536;
    }

    _resolveMaxOutputChars() {
        const value = Number(CONFIG.ai?.maxOutputSize);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10000;
    }

    // ==================================================================
    // Request construction
    // ==================================================================

    /**
     * Normalize the caller prompt into the single `prompt` field understood
     * by the gateway, preserving the distinction between system
     * instructions, bounded context and the user request.
     */
    _normalizePrompt(prompt) {
        const maxChars = this._resolveMaxPromptChars();
        const text = composePrompt(prompt);

        if (!text) {
            throw new AIValidationError('Cannot send an empty request to the ALICE gateway');
        }
        if (text.length > maxChars) {
            throw new AIValidationError(`Prompt exceeds the maximum length of ${maxChars} characters`);
        }
        return text;
    }

    _resolveMaxPromptChars() {
        const value = Number(CONFIG.ai?.gateway?.maxPromptChars);
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10000;
    }

    // ==================================================================
    // Response handling
    // ==================================================================

    /**
     * Read a response body while enforcing a hard byte cap.
     * The stream is abandoned as soon as the cap is exceeded, so an
     * oversized gateway response is never buffered in full.
     */
    async _readLimitedText(response, maxBytes) {
        const declaredLength = readContentLength(response);
        if (declaredLength !== null && declaredLength > maxBytes) {
            await cancelBody(response);
            throw this._oversizeError(maxBytes);
        }

        const stream = response.body;
        if (stream && typeof stream.getReader === 'function') {
            const reader = stream.getReader();
            const decoder = new TextDecoder('utf-8');
            let bytes = 0;
            let text = '';

            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunkBytes = countBytes(value);
                    bytes += chunkBytes;

                    if (bytes > maxBytes) {
                        await cancelBody(response, reader);
                        throw this._oversizeError(maxBytes);
                    }

                    text += typeof value === 'string' ? value : decoder.decode(value, { stream: true });
                }
                text += decoder.decode();
                return text;
            } finally {
                try {
                    if (reader) reader.releaseLock?.();
                } catch (e) {
                    /* lock already released */
                }
            }
        }

        // Fallback for transports without a byte stream (bounded check still applies).
        const text = await response.text();
        if (countBytes(text) > maxBytes) {
            throw this._oversizeError(maxBytes);
        }
        return text;
    }

    _oversizeError(maxBytes) {
        const err = new AIValidationError(
            `ALICE gateway response exceeded the maximum size of ${maxBytes} bytes`
        );
        err.limitBytes = maxBytes;
        return err;
    }

    _safeJsonParse(rawBody) {
        let payload;
        try {
            payload = JSON.parse(rawBody);
        } catch (e) {
            throw new AIValidationError('ALICE gateway returned malformed JSON');
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new AIValidationError('ALICE gateway response must be a JSON object');
        }
        return payload;
    }

    /**
     * Validate the normalized gateway response and reduce it to the
     * ModelAdapter result shape. Nothing else from the gateway payload is
     * forwarded to the caller.
     */
    _normalizeResponse(payload, options = {}) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new AIValidationError('ALICE gateway response must be a JSON object');
        }

        let text;
        if (typeof payload.text === 'string') {
            text = payload.text;
        } else if (payload.text === undefined || payload.text === null) {
            text = '';
        } else {
            throw new AIValidationError('ALICE gateway response field "text" must be a string');
        }

        if (text.trim().length === 0) {
            throw new AIValidationError('ALICE gateway returned an empty response');
        }

        const maxOutputChars = this._resolveMaxOutputChars();
        if (text.length > maxOutputChars) {
            throw new AIValidationError(`Model output exceeded max size limit of ${maxOutputChars} characters`);
        }

        return {
            text,
            structured: this._extractStructured(payload, text, options),
            usage: normalizeUsage(payload.usage)
        };
    }

    _extractStructured(payload, text, options = {}) {
        const maxOutputChars = this._resolveMaxOutputChars();

        // 1. Explicit structured output from the gateway (forward compatible).
        if (payload.structured !== undefined && payload.structured !== null) {
            if (!isPlainObject(payload.structured)) {
                throw new AIValidationError('ALICE gateway response field "structured" must be an object');
            }
            if (JSON.stringify(payload.structured).length > maxOutputChars) {
                throw new AIValidationError(`Model output exceeded max size limit of ${maxOutputChars} characters`);
            }
            assertSafeObject(payload.structured);
            return payload.structured;
        }

        // 2. Structured formats are parsed from the text payload.
        const format = normalizeResponseFormat(options.responseFormat);
        if (STRUCTURED_FORMATS.includes(format)) {
            const parsed = this.parseStructuredOutput(text);
            if (!isPlainObject(parsed)) {
                throw new AIValidationError('Structured model output must be a JSON object');
            }
            assertSafeObject(parsed);
            return parsed;
        }

        // 3. Plain text generation carries no structured payload.
        return null;
    }

    // ==================================================================
    // Error normalization
    // ==================================================================

    _httpError(status, headers, rawErrorBody) {
        const envelope = tryJsonParse(rawErrorBody);
        const gatewayMessage = isPlainObject(envelope) && typeof envelope.error?.message === 'string'
            ? this._sanitizeMessage(envelope.error.message)
            : '';

        const message = gatewayMessage
            || DEFAULT_STATUS_MESSAGES[status]
            || `The ALICE AI gateway returned HTTP ${status}`;

        const err = new AIProviderError(message);
        err.status = status;

        if (isPlainObject(envelope) && typeof envelope.error?.code === 'string') {
            err.gatewayCode = this._sanitizeMessage(envelope.error.code).slice(0, 64);
        }

        if (status === 429) {
            const retryAfter = readHeader(headers, 'retry-after');
            if (retryAfter) err.retryAfter = this._sanitizeMessage(retryAfter).slice(0, 32);
        }

        return err;
    }

    _normalizeTransportError(err, context = { reason: null, timeoutMs: 0 }) {
        if (err instanceof AIValidationError || err instanceof AIProviderError) return err;

        const reason = context.reason;

        if (reason === 'external' || (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'))) {
            if (reason === 'timeout') {
                return new AITimeoutError(`AI request timed out after ${context.timeoutMs}ms`, context.timeoutMs);
            }
            return new AICancellationError('AI request was cancelled by user/caller');
        }

        if (reason === 'timeout' || err?.name === 'TimeoutError') {
            return new AITimeoutError(`AI request timed out after ${context.timeoutMs}ms`, context.timeoutMs);
        }

        return this._networkError(err);
    }

    _networkError(err) {
        const causeCode = String(err?.cause?.code || err?.code || '').toUpperCase();
        const message = NETWORK_CAUSE_MESSAGES[causeCode]
            || 'Unable to reach the ALICE AI gateway. Make sure the local gateway is running.';

        const aiError = new AIProviderError(message);
        // Only a coarse, non-sensitive transport code is retained for logging.
        aiError.transportCode = causeCode || null;
        return aiError;
    }

    /**
     * Strip stack traces, filesystem paths and credential-looking tokens
     * from anything that came back from the network.
     */
    _sanitizeMessage(message) {
        let out = String(message ?? '').replace(/\s+/g, ' ').trim();
        if (!out) return '';

        out = out.slice(0, 300);
        out = out.replace(/(?:[A-Za-z]:\\|\/(?:home|Users|usr|var|etc|tmp|app|srv|opt|data)\/)[^\s"']*/g, '[path]');
        out = out.replace(/\bat\s+[^\s(]+\s*\([^)]*\)/g, '');
        out = redact(out);

        return out.trim();
    }
}

// ==================================================================
// Helpers
// ==================================================================

function normalizeResponseFormat(format) {
    return ALLOWED_RESPONSE_FORMATS.includes(format) ? format : 'json';
}

function normalizeTemperature(temperature) {
    const value = Number(temperature);
    if (!Number.isFinite(value)) {
        const fallback = Number(CONFIG.ai?.temperature);
        return Number.isFinite(fallback) ? clamp(fallback, 0, 2) : 0.2;
    }
    return clamp(value, 0, 2);
}

function normalizeModel(model) {
    if (typeof model !== 'string') return null;
    const trimmed = model.trim();
    return MODEL_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/**
 * Compose the single `prompt` field from either a plain string or an
 * AIBrain-normalized prompt object. Sections are explicitly delimited so
 * the gateway (and the model) can tell system instructions, bounded
 * context and raw user input apart — a prompt-injection defence.
 */
function composePrompt(prompt) {
    if (typeof prompt === 'string') {
        return prompt.replace(/\r\n/g, '\n').trim();
    }

    if (!prompt || typeof prompt !== 'object') return '';

    const sections = [];

    const system = stringifySection(prompt.system ?? prompt.instructions);
    if (system) sections.push(`[SYSTEM INSTRUCTIONS]\n${system}`);

    const tools = stringifySection(prompt.tools);
    if (tools) sections.push(`[AVAILABLE TOOLS]\n${tools}`);

    const context = stringifySection(prompt.context);
    if (context) sections.push(`[BOUNDED CONTEXT]\n${context}`);

    const history = stringifyHistory(prompt.history);
    if (history) sections.push(`[CONVERSATION HISTORY]\n${history}`);

    const request = stringifySection(prompt.request ?? prompt.user ?? prompt.input ?? prompt.goal);
    if (request) sections.push(`[USER REQUEST]\n"${request}"`);

    return sections.join('\n\n').replace(/\r\n/g, '\n').trim();
}

function stringifySection(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
        return value
            .map(item => (typeof item === 'string' ? item : stringifySection(item)))
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch (e) {
            return '';
        }
    }
    return String(value);
}

function stringifyHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    return history
        .map(entry => {
            if (typeof entry === 'string') return entry;
            if (!entry || typeof entry !== 'object') return '';
            const role = entry.role === 'user' ? 'User' : 'ALICE';
            return `${role}: ${String(entry.text ?? '').slice(0, 500)}`;
        })
        .filter(Boolean)
        .join('\n');
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject prototype-pollution style keys anywhere in untrusted structured
 * output before it can reach the planner.
 */
function assertSafeObject(value, depth = 0, seen = new WeakSet()) {
    if (depth > MAX_STRUCTURED_DEPTH) {
        throw new AIValidationError('Structured model output is nested too deeply');
    }
    if (!isPlainObject(value) && !Array.isArray(value)) return;
    if (seen.has(value)) return;
    seen.add(value);

    const entries = Array.isArray(value)
        ? value.map((item, index) => [String(index), item])
        : Object.entries(value);

    if (entries.length > MAX_STRUCTURED_KEYS) {
        throw new AIValidationError('Structured model output contains too many fields');
    }

    for (const [key, child] of entries) {
        if (UNSAFE_KEYS.has(key)) {
            throw new AIValidationError('Structured model output contains unsafe object keys');
        }
        if (isPlainObject(child) || Array.isArray(child)) {
            assertSafeObject(child, depth + 1, seen);
        }
    }
}

function normalizeUsage(usage) {
    if (!isPlainObject(usage)) return null;

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

function tryJsonParse(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

function readContentLength(response) {
    const value = readHeader(response?.headers, 'content-length');
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readHeader(headers, name) {
    if (!headers) return null;
    try {
        if (typeof headers.get === 'function') return headers.get(name);
        if (typeof headers === 'object') {
            const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
            return key ? headers[key] : null;
        }
    } catch (e) {
        /* opaque headers object */
    }
    return null;
}

async function cancelBody(response, reader = null) {
    try {
        if (reader && typeof reader.cancel === 'function') {
            await reader.cancel();
            return;
        }
        if (response?.body?.cancel && typeof response.body.cancel === 'function') {
            await response.body.cancel();
        }
    } catch (e) {
        /* best-effort: the socket is already being discarded */
    }
}

function countBytes(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'string') {
        try {
            return new TextEncoder().encode(value).length;
        } catch (e) {
            return value.length;
        }
    }
    if (typeof value.byteLength === 'number') return value.byteLength;
    if (typeof value.length === 'number') return value.length;
    return 0;
}

export default HttpModelAdapter;
