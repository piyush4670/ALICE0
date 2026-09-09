// Tests for HTTP Model Adapter (Phase 6.3.2)
// ------------------------------------------------------------------
// These tests NEVER contact a real AI provider. Every network call is made
// against a local, in-process mock gateway (or the real Phase 6.3.1 gateway
// running with its zero-network 'mock' provider) bound to 127.0.0.1.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The real fetch is captured before any skill stubs replace globalThis.fetch,
// so the adapter under test always uses a genuine HTTP transport.
const realFetch = globalThis.fetch;

// ------------------------------------------------------------------
// Minimal browser globals required by the ALICE modules
// ------------------------------------------------------------------
const localStorageReads = [];
globalThis.localStorage = {
    _d: {},
    getItem(k) { localStorageReads.push(k); return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; } },
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
    AudioContext: undefined,
    webkitAudioContext: undefined
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: undefined, permissions: undefined }, configurable: true });
globalThis.document = {
    createElement() {
        return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return null; } };
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};
globalThis.Blob = class { constructor() {} };
// NOTE: the real URL constructor is preserved on purpose (the adapter needs
// it to validate gateway URLs); only the browser-only helpers are added.
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};

// Skill-side fetch stub (websearch). The adapter never uses the global stub
// in these tests: it is constructed with an explicit fetchImpl.
globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
        AbstractText: 'Quantum computing is computation using quantum mechanical phenomena such as superposition and entanglement.',
        Heading: 'Quantum computing',
        AbstractURL: 'https://en.wikipedia.org/wiki/Quantum_computing'
    })
});

const { CONFIG } = await import('../js/config.js');
const { HttpModelAdapter, GATEWAY_DEFAULT_PATH, resolveGatewayUrl, resolveGatewayTrustToken } = await import('../js/ai/httpModelAdapter.js');
const { ModelAdapter, AIError, AIValidationError, AIProviderError, AITimeoutError, AICancellationError } = await import('../js/ai/modelAdapter.js');
const { MockAdapter } = await import('../js/ai/mockAdapter.js');
const { aiBrain } = await import('../js/ai/aiBrain.js');
const { planValidator } = await import('../js/ai/planValidator.js');
const { taskPlanner } = await import('../js/taskPlanner.js');
const { agent } = await import('../js/agent.js');
const { state } = await import('../js/state.js');
const { createGatewayServer, ERROR_CODES } = await import('../server/gateway.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

// ==================================================================
// Mock local gateway (stand-in for server/gateway.js)
// ==================================================================

function startMockGateway() {
    const recorded = [];
    let handler = () => ({ status: 200, body: JSON.stringify({ text: 'ok', usage: null }) });

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', async () => {
            let parsedBody = null;
            try { parsedBody = JSON.parse(raw); } catch (e) { parsedBody = null; }

            recorded.push({
                method: req.method,
                url: req.url,
                headers: req.headers,
                raw,
                body: parsedBody
            });

            let result;
            try {
                result = await handler({ req, body: parsedBody, raw });
            } catch (e) {
                result = { status: 500, body: JSON.stringify({ error: { code: 'AI_GATEWAY_ERROR', message: 'handler error' } }) };
            }

            const status = result.status || 200;
            const headers = { 'Content-Type': 'application/json', ...(result.headers || {}) };
            const payload = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);

            res.writeHead(status, headers);
            res.end(payload);
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                server,
                port: server.address().port,
                url: `http://127.0.0.1:${server.address().port}`,
                recorded,
                setHandler(fn) { handler = fn; },
                clear() { recorded.length = 0; },
                close: () => new Promise(r => server.close(r))
            });
        });
    });
}

/** Allocate a TCP port, release it, and return it (guaranteed connection-refused). */
async function reserveDeadPort() {
    const server = http.createServer();
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    await new Promise(r => server.close(r));
    return port;
}

function makeAdapter(gateway, extra = {}) {
    return new HttpModelAdapter({
        gatewayUrl: typeof gateway === 'object' ? gateway.url : gateway,
        fetchImpl: realFetch,
        ...extra
    });
}

const VALID_PLAN = {
    goal: 'research quantum computing and summarize',
    steps: [
        { id: 'step_1', skill: 'websearch', action: 'search', input: 'quantum computing', contextKey: 'research', dependsOn: [] },
        { id: 'step_2', skill: 'core', operation: 'summarize', input: '', inputSource: 'research', contextKey: 'summary', dependsOn: ['step_1'] }
    ]
};

const gw = await startMockGateway();

// ==================================================================
// 1) Successful request
// ==================================================================
console.log('1) Successful request against the local gateway');
{
    gw.clear();
    gw.setHandler(() => ({
        status: 200,
        body: { text: 'ALICE online.', usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }
    }));

    const adapter = makeAdapter(gw);
    const result = await adapter.generate('hello ALICE', { responseFormat: 'text' });

    check('returns text from the gateway', result.text === 'ALICE online.');
    check('text response has no structured payload', result.structured === null);
    check('usage is normalized (snake_case → camelCase)', result.usage?.promptTokens === 12 && result.usage?.totalTokens === 16);
    check('usage drops unknown gateway fields', result.usage?.model === undefined);
    check('exactly one request was sent', gw.recorded.length === 1);

    const sent = gw.recorded[0];
    check('request uses POST', sent.method === 'POST');
    check('request targets the gateway generate path', sent.url === GATEWAY_DEFAULT_PATH);
    check('request content-type is application/json', (sent.headers['content-type'] || '').includes('application/json'));
    check('request body contains the prompt', sent.body?.prompt === 'hello ALICE');
    check('request body carries the response format', sent.body?.responseFormat === 'text');
    check('request body carries a bounded temperature', sent.body?.temperature === CONFIG.ai.temperature);
    check('request body only sends whitelisted fields',
        Object.keys(sent.body || {}).every(k => ['prompt', 'responseFormat', 'temperature', 'model'].includes(k)));
    check('no authorization header is sent', !('authorization' in sent.headers));
    check('no trust token header is sent when unconfigured', !('x-local-trust-token' in sent.headers));
}

// ==================================================================
// 2) Structured response
// ==================================================================
console.log('2) Structured response handling');
{
    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: JSON.stringify(VALID_PLAN), usage: null } }));

    const adapter = makeAdapter(gw);
    const result = await adapter.generate('research quantum computing and summarize', { responseFormat: 'plan' });

    check('structured plan is parsed', !!result.structured && Array.isArray(result.structured.steps));
    check('structured plan matches the gateway payload', result.structured.goal === VALID_PLAN.goal);
    check('raw text is preserved', typeof result.text === 'string' && result.text.length > 0);

    // Explicit `structured` field from the gateway is accepted and validated
    gw.clear();
    gw.setHandler(() => ({
        status: 200,
        body: { text: 'ignored', structured: { response: 'Structured channel works.' }, usage: null }
    }));
    const adapter2 = makeAdapter(gw);
    const result2 = await adapter2.generate('anything', { responseFormat: 'json' });
    check('explicit structured field is accepted', result2.structured?.response === 'Structured channel works.');

    // AIBrain end-to-end through the HTTP adapter
    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: JSON.stringify(VALID_PLAN), usage: null } }));
    const brainAdapter = makeAdapter(gw);
    aiBrain.setAdapter(brainAdapter);
    const brainResult = await aiBrain.processRequest('research quantum computing and summarize');
    check('AIBrain accepts the HTTP adapter', aiBrain.getAdapter() === brainAdapter);
    check('AIBrain returns a validated multi-step plan', brainResult.success === true && brainResult.isMultiStep === true);
    check('plan was normalized by PlanValidator', Array.isArray(brainResult.plan) && brainResult.plan.length === 2);
}

// ==================================================================
// 3) Malformed JSON
// ==================================================================
console.log('3) Malformed JSON from the gateway');
{
    gw.clear();
    gw.setHandler(() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: '{ "text": "unterminated ' }));

    const adapter = makeAdapter(gw);
    let err = null;
    try {
        await adapter.generate('hello', { responseFormat: 'text' });
    } catch (e) {
        err = e;
    }
    check('malformed JSON rejects with AIValidationError', err instanceof AIValidationError);
    check('malformed JSON error is part of the AI error hierarchy', err instanceof AIError);
    check('malformed JSON message is safe and generic', /malformed json/i.test(err?.message || ''));
    check('malformed JSON exposes no stack trace', !/at\s+\w+\s+\(/.test(err?.message || ''));
}

// ==================================================================
// 4) Empty response
// ==================================================================
console.log('4) Empty response from the gateway');
{
    gw.clear();
    gw.setHandler(() => ({ status: 200, body: '' }));
    const adapter = makeAdapter(gw);
    let err = null;
    try { await adapter.generate('hello', { responseFormat: 'text' }); } catch (e) { err = e; }
    check('empty body rejects with AIValidationError', err instanceof AIValidationError);
    check('empty body message is safe', /empty response/i.test(err?.message || ''));

    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: '   ', usage: null } }));
    let err2 = null;
    try { await adapter.generate('hello', { responseFormat: 'text' }); } catch (e) { err2 = e; }
    check('whitespace-only text rejects with AIValidationError', err2 instanceof AIValidationError);
}

// ==================================================================
// 5) HTTP 400
// ==================================================================
console.log('5) HTTP 400 handling');
{
    gw.clear();
    gw.setHandler(() => ({
        status: 400,
        body: { error: { code: ERROR_CODES.BAD_REQUEST, message: 'Field "prompt" is required' } }
    }));

    const adapter = makeAdapter(gw);
    let err = null;
    try { await adapter.generate('hello'); } catch (e) { err = e; }
    check('HTTP 400 rejects with AIProviderError', err instanceof AIProviderError);
    check('HTTP status is preserved on the error', err?.status === 400);
    check('gateway error code is preserved', err?.gatewayCode === ERROR_CODES.BAD_REQUEST);
    check('gateway message is surfaced safely', /prompt/i.test(err?.message || ''));

    // Leaked internals in the gateway message must be stripped
    gw.clear();
    gw.setHandler(() => ({
        status: 400,
        body: { error: { code: ERROR_CODES.BAD_REQUEST, message: 'Failure at /home/user/ALICE0/server/gateway.js (line 42) key sk-abcdef1234567890' } }
    }));
    let err2 = null;
    try { await adapter.generate('hello'); } catch (e) { err2 = e; }
    check('filesystem paths are stripped from gateway errors', !/home\/user|gateway\.js/.test(err2?.message || ''));
    check('credential-looking tokens are redacted', !/sk-abcdef/.test(err2?.message || ''));
}

// ==================================================================
// 6) HTTP 429
// ==================================================================
console.log('6) HTTP 429 (rate limit) handling');
{
    gw.clear();
    gw.setHandler(() => ({
        status: 429,
        headers: { 'Retry-After': '60' },
        body: { error: { code: ERROR_CODES.RATE_LIMITED, message: 'Rate limit exceeded. Please slow down.' } }
    }));

    const adapter = makeAdapter(gw);
    let err = null;
    try { await adapter.generate('hello'); } catch (e) { err = e; }
    check('HTTP 429 rejects with AIProviderError', err instanceof AIProviderError);
    check('HTTP 429 status is preserved', err?.status === 429);
    check('retry-after hint is captured', err?.retryAfter === '60');
    check('no retry storm is attempted (single request)', gw.recorded.length === 1);
    check('rate-limit message is user safe', /rate limit/i.test(err?.message || ''));
}

// ==================================================================
// 7) HTTP 500
// ==================================================================
console.log('7) HTTP 500 handling');
{
    gw.clear();
    gw.setHandler(() => ({ status: 500, body: '<html>internal server error stack trace</html>' }));

    const adapter = makeAdapter(gw);
    let err = null;
    try { await adapter.generate('hello'); } catch (e) { err = e; }
    check('HTTP 500 rejects with AIProviderError', err instanceof AIProviderError);
    check('HTTP 500 status is preserved', err?.status === 500);
    check('non-JSON error body falls back to a safe message', /internal error|returned HTTP 500/i.test(err?.message || ''));
    check('no raw server payload is leaked', !/html|stack/i.test(err?.message || ''));
}

// ==================================================================
// 8) Connection failure
// ==================================================================
console.log('8) Connection failure handling');
{
    const deadPort = await reserveDeadPort();
    const adapter = new HttpModelAdapter({
        gatewayUrl: `http://127.0.0.1:${deadPort}`,
        fetchImpl: realFetch,
        timeout: 2000
    });

    let err = null;
    try { await adapter.generate('hello'); } catch (e) { err = e; }
    check('connection refused rejects with AIProviderError', err instanceof AIProviderError);
    check('connection failure message is user safe', /gateway/i.test(err?.message || ''));
    check('connection failure exposes no filesystem paths', !/\/home\/|C:\\/.test(err?.message || ''));
    check('connection failure exposes no stack trace', !/at\s+\w+\s+\(/.test(err?.message || ''));
    check('transport cause code is retained for logging', err?.transportCode === 'ECONNREFUSED');

    // An unresolvable destination is refused at URL validation time — the
    // adapter never even opens a socket to a non-gateway host.
    let hostErr = null;
    try {
        new HttpModelAdapter({ gatewayUrl: 'http://alice-gateway-does-not-exist.invalid:8787/api/ai/generate' }).getGatewayUrl();
    } catch (e) { hostErr = e; }
    check('non-loopback host is refused before any network call', hostErr instanceof AIValidationError);

    // DNS / network failure normalization (simulated transport, no real DNS)
    const dnsError = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const dnsAdapter = new HttpModelAdapter({ gatewayUrl: gw.url, fetchImpl: async () => { throw dnsError; } });
    let dnsErr = null;
    try { await dnsAdapter.generate('hello'); } catch (e) { dnsErr = e; }
    check('DNS failure rejects with AIProviderError', dnsErr instanceof AIProviderError);
    check('DNS failure message is user safe', /could not be resolved|gateway/i.test(dnsErr?.message || ''));
    check('DNS failure exposes no raw OS error text', !/getaddrinfo|ENOTFOUND/.test(dnsErr?.message || ''));
    check('DNS failure keeps a coarse transport code', dnsErr?.transportCode === 'ENOTFOUND');
}

// ==================================================================
// 9) Timeout
// ==================================================================
console.log('9) Timeout handling');
{
    gw.clear();
    gw.setHandler(async () => {
        await new Promise(r => setTimeout(r, 600));
        return { status: 200, body: { text: 'too late', usage: null } };
    });

    const adapter = makeAdapter(gw, { timeout: 120 });
    const started = Date.now();
    let err = null;
    try { await adapter.generate('hello', { responseFormat: 'text' }); } catch (e) { err = e; }
    const elapsed = Date.now() - started;

    check('slow gateway rejects with AITimeoutError', err instanceof AITimeoutError);
    check('timeout error is part of the AI error hierarchy', err instanceof AIError);
    check('timeout fires close to the configured deadline', elapsed < 900);
    check('timeout details carry the deadline', err?.details?.timeoutMs === 120);

    // The aborted request must not leave a hanging promise behind
    const settled = await Promise.race([
        adapter.generate('hello', { responseFormat: 'text', timeout: 120 }).then(() => 'resolved').catch(e => e.name),
        new Promise(r => setTimeout(() => r('HUNG'), 2000))
    ]);
    check('no hanging promise after timeout', settled !== 'HUNG');
}

// ==================================================================
// 10) AbortSignal cancellation
// ==================================================================
console.log('10) AbortSignal cancellation');
{
    gw.clear();
    gw.setHandler(async () => {
        await new Promise(r => setTimeout(r, 600));
        return { status: 200, body: { text: 'too late', usage: null } };
    });

    const adapter = makeAdapter(gw, { timeout: 5000 });
    const controller = new AbortController();
    const promise = adapter.generate('hello', { responseFormat: 'text', signal: controller.signal, timeout: 5000 });
    setTimeout(() => controller.abort(), 60);

    let err = null;
    try { await promise; } catch (e) { err = e; }
    check('AbortSignal rejects with AICancellationError', err instanceof AICancellationError);
    check('cancellation is distinguished from timeout', !(err instanceof AITimeoutError));

    // Pre-aborted signal
    const preAborted = new AbortController();
    preAborted.abort();
    let err2 = null;
    try { await adapter.generate('hello', { signal: preAborted.signal }); } catch (e) { err2 = e; }
    check('pre-aborted signal rejects immediately', err2 instanceof AICancellationError);
    check('pre-aborted signal sends no request', gw.recorded.length === 1);
}

// ==================================================================
// 11) Oversized response
// ==================================================================
console.log('11) Oversized response rejection');
{
    gw.clear();
    const hugeText = 'A'.repeat(400000);
    gw.setHandler(() => ({ status: 200, body: { text: hugeText, usage: null } }));

    const adapter = makeAdapter(gw, { maxResponseBytes: 4096 });
    let err = null;
    try { await adapter.generate('hello', { responseFormat: 'text' }); } catch (e) { err = e; }
    check('oversized response rejects with AIValidationError', err instanceof AIValidationError);
    check('oversized response message names the limit', /maximum size of 4096 bytes/.test(err?.message || ''));
    check('oversized response is not returned to the caller', !String(err?.text || '').includes('AAAA'));

    // Content-Length shortcut
    gw.clear();
    gw.setHandler(() => ({
        status: 200,
        headers: { 'Content-Length': '999999' },
        body: { text: 'never read', usage: null }
    }));
    let err2 = null;
    try { await adapter.generate('hello', { responseFormat: 'text' }); } catch (e) { err2 = e; }
    check('declared Content-Length over the cap is rejected', err2 instanceof AIValidationError);

    // Model output larger than CONFIG.ai.maxOutputSize is rejected too
    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: 'B'.repeat(CONFIG.ai.maxOutputSize + 500), usage: null } }));
    const bigAdapter = makeAdapter(gw, { maxResponseBytes: 10 * 1024 * 1024 });
    let err3 = null;
    try { await bigAdapter.generate('hello', { responseFormat: 'text' }); } catch (e) { err3 = e; }
    check('model output above CONFIG.ai.maxOutputSize is rejected', err3 instanceof AIValidationError);
}

// ==================================================================
// 12) Malformed gateway response
// ==================================================================
console.log('12) Malformed gateway response shapes');
{
    const adapter = makeAdapter(gw, { maxResponseBytes: 4096 });

    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { unexpected: 'shape' } }));
    let err1 = null;
    try { await adapter.generate('hello', { responseFormat: 'text' }); } catch (e) { err1 = e; }
    check('response without text field is rejected', err1 instanceof AIValidationError);

    gw.clear();
    gw.setHandler(() => ({ status: 200, body: [1, 2, 3] }));
    let err2 = null;
    try { await adapter.generate('hello', { responseFormat: 'text' }); } catch (e) { err2 = e; }
    check('array response is rejected', err2 instanceof AIValidationError);

    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: 42 } }));
    let err3 = null;
    try { await adapter.generate('hello', { responseFormat: 'text' }); } catch (e) { err3 = e; }
    check('non-string text field is rejected', err3 instanceof AIValidationError);

    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: '{"steps":"not-an-array"}', usage: null } }));
    // The adapter only guarantees *syntactically* valid JSON; semantic
    // rejection of a non-plan is AIBrain's job (and never reaches execution).
    const shapeAdapter = makeAdapter(gw);
    aiBrain.setAdapter(shapeAdapter);
    const shapeResult = await aiBrain.processRequest('do the thing');
    check('JSON that is not a plan never becomes an executable plan', shapeResult.success === false);
    check('non-plan JSON raises the fallback flag', shapeResult.fallback === true);

    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: '{"__proto__":{"polluted":true}}', usage: null } }));
    let err5 = null;
    try { await adapter.generate('hello', { responseFormat: 'plan' }); } catch (e) { err5 = e; }
    check('prototype-pollution keys in structured output are rejected', err5 instanceof AIValidationError);

    // Redirects must never silently move the destination
    gw.clear();
    gw.setHandler(() => ({ status: 302, headers: { Location: 'https://api.groq.com/openai/v1/chat/completions' }, body: '' }));
    let err6 = null;
    try { await adapter.generate('hello'); } catch (e) { err6 = e; }
    check('redirect responses are rejected', err6 instanceof AIProviderError && err6.status === 302);
}

// ==================================================================
// 13) Credential leakage prevention
// ==================================================================
console.log('13) Credential leakage prevention');
{
    localStorageReads.length = 0;
    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: 'ok', usage: null } }));

    const adapter = makeAdapter(gw);

    // Caller attempts to smuggle a destination, headers or credentials
    const result = await adapter.generate('hello', {
        responseFormat: 'text',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk-should-never-be-sent',
        authorization: 'Bearer sk-should-never-be-sent',
        headers: { Authorization: 'Bearer sk-should-never-be-sent' },
        model: 'llama-3.3-70b-versatile'
    });

    check('generation still succeeds with a clean contract', result.text === 'ok');
    check('request was sent to the local gateway only', gw.recorded[0]?.url === GATEWAY_DEFAULT_PATH);
    check('request host is the local mock gateway', (gw.recorded[0]?.headers?.host || '').startsWith('127.0.0.1:'));
    check('no authorization header was sent', !('authorization' in gw.recorded[0].headers));
    check('no api key was serialized into the body', !/sk-should-never-be-sent/.test(gw.recorded[0].raw));
    check('no provider host was serialized into the request', !/groq|openai|anthropic|generativelanguage/i.test(gw.recorded[0].raw));
    check('only whitelisted body fields were sent',
        Object.keys(gw.recorded[0].body).sort().join(',') === 'model,prompt,responseFormat,temperature');
    check('adapter never reads localStorage for configuration', localStorageReads.length === 0);

    // Inspect the outbound contract without any network call at all
    const built = adapter.buildRequest('hello', { responseFormat: 'text' });
    check('buildRequest returns the gateway URL', built.url === `${gw.url}${GATEWAY_DEFAULT_PATH}`);
    check('buildRequest sends no Authorization header',
        Object.keys(built.init.headers).every(h => h.toLowerCase() !== 'authorization'));
    check('buildRequest sends only Content-Type/Accept headers',
        Object.keys(built.init.headers).sort().join(',') === 'Accept,Content-Type');
    check('buildRequest never follows redirects', built.init.redirect === 'manual');
    check('buildRequest never sends cookies', built.init.credentials === 'omit');

    // Static source inspection of the client-side adapter
    const source = readFileSync(join(__dirname, '..', 'js', 'ai', 'httpModelAdapter.js'), 'utf8');
    check('adapter source never touches web storage (property/method access)',
        !/localStorage\s*[.[]|sessionStorage\s*[.[]|window\.localStorage/.test(source));
    check('adapter source never reads a credential from storage', !/getItem\s*\(\s*['"`]/i.test(source));
    check('adapter source contains no Authorization header', !/Authorization\s*[:=]/.test(source));
    check('adapter source contains no api key field', !/api[_-]?key/i.test(source));
    check('adapter source contains no provider hostnames',
        !/api\.groq\.com|api\.openai\.com|openrouter\.ai|generativelanguage/i.test(source));
    check('adapter source contains no hardcoded credential literals', !/\bsk-[A-Za-z0-9]{6,}/.test(source));

    // Client configuration must not carry provider credentials
    const configSource = readFileSync(join(__dirname, '..', 'js', 'config.js'), 'utf8');
    check('CONFIG contains no provider api keys', !/apiKey|GROQ_API_KEY|OPENAI_API_KEY/i.test(configSource));
    check('CONFIG.ai.gateway holds no secret values',
        CONFIG.ai.gateway.url === '' && CONFIG.ai.gateway.trustToken === '');
    check('CONFIG.ai.adapter still defaults to mock', CONFIG.ai.adapter === 'mock');
}

// ==================================================================
// 14) Gateway URL configuration
// ==================================================================
console.log('14) Gateway URL configuration');
{
    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: 'configured', usage: null } }));

    // Origin-only environment variable → default path appended
    process.env.AI_GATEWAY_URL = `http://127.0.0.1:${gw.port}`;
    const envAdapter = new HttpModelAdapter({ fetchImpl: realFetch });
    const envResult = await envAdapter.generate('hello', { responseFormat: 'text' });
    check('AI_GATEWAY_URL is honoured', envResult.text === 'configured');
    check('default gateway path is appended to an origin-only URL',
        gw.recorded[gw.recorded.length - 1]?.url === GATEWAY_DEFAULT_PATH);
    check('resolved URL uses the configured port', envAdapter.getGatewayUrl() === `http://127.0.0.1:${gw.port}${GATEWAY_DEFAULT_PATH}`);

    // Explicit config overrides the environment
    process.env.AI_GATEWAY_URL = 'http://127.0.0.1:1/should-not-be-used';
    const explicit = new HttpModelAdapter({ gatewayUrl: `${gw.url}/custom/path`, fetchImpl: realFetch });
    check('explicit config URL wins over environment', explicit.getGatewayUrl() === `${gw.url}/custom/path`);
    delete process.env.AI_GATEWAY_URL;

    // Environment with an explicit path is preserved
    process.env.AI_GATEWAY_URL = `${gw.url}/api/ai/generate`;
    check('env URL with a path is preserved',
        new HttpModelAdapter({ fetchImpl: realFetch }).getGatewayUrl() === `${gw.url}/api/ai/generate`);
    delete process.env.AI_GATEWAY_URL;

    // Same-origin relative path (browser deployment)
    check('relative same-origin path is accepted', resolveGatewayUrl({ gatewayUrl: '/api/ai/generate' }) === '/api/ai/generate');

    // Rejected destinations
    const rejected = [
        'https://api.groq.com/openai/v1/chat/completions',
        'https://api.openai.com/v1/chat/completions',
        'https://openrouter.ai/api/v1/chat/completions',
        'http://evil-attacker.example.com/api/ai/generate',
        'http://169.254.169.254/latest/meta-data/',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'data:text/plain,hello',
        '//evil-attacker.example.com/api',
        'https://user:password@127.0.0.1/api/ai/generate',
        'relative/path'
    ];
    let rejectedCount = 0;
    for (const candidate of rejected) {
        let threw = false;
        try { resolveGatewayUrl({ gatewayUrl: candidate }); } catch (e) { threw = e instanceof AIValidationError; }
        if (threw) rejectedCount++;
    }
    check('provider URLs and exotic destinations are refused', rejectedCount === rejected.length);

    // Loopback variants are always permitted
    check('localhost loopback is permitted', resolveGatewayUrl({ gatewayUrl: 'http://localhost:8787/api/ai/generate' }) === 'http://localhost:8787/api/ai/generate');
    check('ipv6 loopback is permitted', resolveGatewayUrl({ gatewayUrl: 'http://[::1]:8787/api/ai/generate' }) === 'http://[::1]:8787/api/ai/generate');
}

// ==================================================================
// 15) Local trust-token handling
// ==================================================================
console.log('15) Local trust-token handling');
{
    // Against the real Phase 6.3.1 gateway (mock provider, zero network egress)
    const realGw = createGatewayServer({ port: 0, provider: 'mock', localTrustToken: 'alice-local-token' });
    await new Promise(r => realGw.listen(0, '127.0.0.1', r));
    const realPort = realGw.address().port;

    process.env.LOCAL_TRUST_TOKEN = 'alice-local-token';
    const tokenAdapter = new HttpModelAdapter({
        gatewayUrl: `http://127.0.0.1:${realPort}`,
        fetchImpl: realFetch,
        timeout: 3000
    });
    const okResult = await tokenAdapter.generate(
        'research quantum computing, summarize the important information and create a document',
        { responseFormat: 'plan' }
    );
    check('token from runtime environment is accepted by the gateway', !!okResult.text);
    check('gateway plan is parsed into structured output', Array.isArray(okResult.structured?.steps));

    delete process.env.LOCAL_TRUST_TOKEN;
    const noTokenAdapter = new HttpModelAdapter({
        gatewayUrl: `http://127.0.0.1:${realPort}`,
        fetchImpl: realFetch,
        timeout: 3000
    });
    let tokenErr = null;
    try { await noTokenAdapter.generate('hello', { responseFormat: 'text' }); } catch (e) { tokenErr = e; }
    check('missing trust token produces HTTP 401', tokenErr?.status === 401);
    check('missing trust token is normalized to AIProviderError', tokenErr instanceof AIProviderError);

    // Explicit token, and header-injection safety
    const explicitToken = new HttpModelAdapter({
        gatewayUrl: `http://127.0.0.1:${realPort}`,
        trustToken: 'alice-local-token',
        fetchImpl: realFetch,
        timeout: 3000
    });
    const explicitResult = await explicitToken.generate('hello', { responseFormat: 'text' });
    check('explicit local trust token is accepted', !!explicitResult.text);
    check('resolved trust token matches configuration', resolveGatewayTrustToken({ trustToken: 'abc' }) === 'abc');

    let injectErr = null;
    try { resolveGatewayTrustToken({ trustToken: 'abc\r\nX-Evil: 1' }); } catch (e) { injectErr = e; }
    check('trust token with CR/LF is rejected (header injection guard)', injectErr instanceof AIValidationError);

    await new Promise(r => realGw.close(r));
}

// ==================================================================
// 16) MockAdapter still works
// ==================================================================
console.log('16) MockAdapter still works');
{
    check('AIBrain registry exposes mock + http adapters',
        aiBrain.getAvailableAdapters().sort().join(',') === 'http,mock');

    const mockFromFactory = aiBrain.createAdapter('mock');
    check('factory creates a MockAdapter', mockFromFactory instanceof MockAdapter);
    check('MockAdapter is a ModelAdapter', mockFromFactory instanceof ModelAdapter);

    const a = await mockFromFactory.generate('research quantum computing and summarize');
    const b = await mockFromFactory.generate('research quantum computing and summarize');
    check('MockAdapter remains deterministic', JSON.stringify(a.structured) === JSON.stringify(b.structured));
    check('MockAdapter makes zero network requests', true);

    let unknownErr = null;
    try { aiBrain.createAdapter('openai-direct'); } catch (e) { unknownErr = e; }
    check('unknown adapter identifiers are refused', unknownErr instanceof Error);

    aiBrain.setAdapter(mockFromFactory);
    check('mock adapter can be reinstalled', aiBrain.getAdapterName() === 'MockAdapter');
    const mockResult = await aiBrain.processRequest('research quantum computing, summarize the important information and create a document');
    check('AIBrain still plans with MockAdapter', mockResult.success === true && mockResult.isMultiStep === true);

    // A fresh AIBrain defaults to the mock adapter (http is not the default)
    const { AIBrain } = await import('../js/ai/aiBrain.js');
    const freshBrain = new AIBrain();
    check('fresh AIBrain defaults to the mock adapter', freshBrain.getAdapterName() === 'MockAdapter');
    check('default remains offline-safe', CONFIG.ai.adapter === 'mock');
}

// ==================================================================
// 17) Deterministic fallback still works
// ==================================================================
console.log('17) Deterministic fallback still works');
{
    const deadPort = await reserveDeadPort();
    const failingAdapter = new HttpModelAdapter({
        gatewayUrl: `http://127.0.0.1:${deadPort}`,
        fetchImpl: realFetch,
        timeout: 1500
    });

    aiBrain.setAdapter(failingAdapter);
    const aiResult = await aiBrain.processRequest('research quantum computing, summarize the important information and create a document');
    check('unreachable gateway makes AIBrain report failure', aiResult.success === false);
    check('failure raises the fallback flag', aiResult.fallback === true);
    check('failure is normalized into the AI error hierarchy', aiResult.code === 'AI_PROVIDER');

    // Deterministic planner still completes the task with no AI at all
    state.resetTask();
    const plan = taskPlanner.analyze('research quantum computing, summarize the important information and create a document');
    check('deterministic planner still produces a plan', plan.isMultiStep === true && plan.plan.length === 3);

    const agentResult = await agent.process('research quantum computing, summarize the important information and create a document', { speak: () => {} });
    check('deterministic fallback completes the task', agentResult?.success === true);
    check('task state reports completion', state.getTask().status === 'completed');

    aiBrain.setAdapter(aiBrain.createAdapter('mock'));
}

// ==================================================================
// 18) PlanValidator remains in the execution path
// ==================================================================
console.log('18) PlanValidator remains in the execution path');
{
    let executed = false;
    const { skillManager } = await import('../js/skillManager.js');
    skillManager.register({
        name: 'httpAdapterTrap',
        description: 'Skill that must never execute from an unvalidated plan',
        patterns: [/^httpadaptertrap/],
        risk: 'safe',
        execute() { executed = true; return { success: true, result: 'trap' }; }
    });

    const cases = [
        {
            name: 'unknown skill',
            payload: { goal: 'x', steps: [{ id: 'step_1', skill: 'nonExistentTool', input: 'hack' }] }
        },
        {
            name: 'executable code injection',
            payload: { goal: 'x', steps: [{ id: 'step_1', skill: 'notes', input: 'eval("process.exit(1)")' }] }
        },
        {
            name: 'cyclic dependencies',
            payload: {
                goal: 'x',
                steps: [
                    { id: 's1', skill: 'httpAdapterTrap', dependsOn: ['s2'] },
                    { id: 's2', skill: 'httpAdapterTrap', dependsOn: ['s1'] }
                ]
            }
        },
        {
            name: 'duplicate step ids',
            payload: {
                goal: 'x',
                steps: [
                    { id: 'dup', skill: 'calculator', input: '1+1' },
                    { id: 'dup', skill: 'calculator', input: '2+2' }
                ]
            }
        }
    ];

    for (const testCase of cases) {
        gw.clear();
        gw.setHandler(() => ({ status: 200, body: { text: JSON.stringify(testCase.payload), usage: null } }));
        const adapter = makeAdapter(gw);
        aiBrain.setAdapter(adapter);

        const result = await aiBrain.processRequest('do the thing');
        check(`gateway plan with ${testCase.name} is rejected by PlanValidator`, result.success === false);
        check(`plan with ${testCase.name} never reaches execution`, executed === false);
    }

    // A valid plan from the HTTP adapter is validated and normalized
    gw.clear();
    gw.setHandler(() => ({ status: 200, body: { text: JSON.stringify(VALID_PLAN), usage: null } }));
    aiBrain.setAdapter(makeAdapter(gw));
    const validResult = await aiBrain.processRequest('research quantum computing and summarize');
    check('valid gateway plan passes PlanValidator', validResult.success === true);
    check('validator is the PlanValidator instance', aiBrain.getValidator() === planValidator);
    check('normalized plan has no unvalidated fields', validResult.plan.every(s => typeof s.skill === 'string'));

    const directValidation = planValidator.validate(VALID_PLAN);
    check('PlanValidator directly accepts the same plan', directValidation.valid === true);

    aiBrain.setAdapter(aiBrain.createAdapter('mock'));
}

await gw.close();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
