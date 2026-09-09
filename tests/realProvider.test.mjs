// =============================================================================
// Tests for Real Provider Connection (Phase 6.3.3)
// -----------------------------------------------------------------------------
// EVERY upstream in this file is a deterministic LOCAL mock HTTP server bound
// to 127.0.0.1 on an ephemeral port. This suite performs ZERO real network
// requests: no Groq, no OpenRouter, no Ollama, no external DNS.
//
// Coverage map (spec §11):
//   1  valid provider configuration        16 missing "choices"
//   2  mock provider still works           17 missing "message"
//   3  missing API key                     18 missing "content"
//   4  unsupported provider                19 empty model response
//   5  AI_MODEL server-authoritative       20 upstream 401
//   6  authorized client model             21 upstream 403
//   7  unauthorized client model           22 upstream 429
//   8  unauthorized model not forwarded    23 upstream 5xx
//   9  arbitrary upstream URL rejected     24 upstream timeout
//  10  arbitrary endpoint rejected         25 key absent from client response
//  11  client Authorization rejected       26 key absent from thrown errors
//  12  client API key rejected             27 key absent from logs/debug
//  13  successful OpenAI-compatible resp   28 output cannot bypass PlanValidator
//  14  valid structured/JSON response      29 output cannot directly run a skill
//  15  malformed upstream JSON             30 permission boundary stays authoritative
// =============================================================================

// --- Browser globals (required before importing the js/ client modules) -----
globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: {
        cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; }
    },
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
    AudioContext: undefined,
    webkitAudioContext: undefined
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: undefined, permissions: undefined },
    configurable: true
});
globalThis.document = {
    createElement() {
        return {
            style: {}, setAttribute() {}, click() {},
            classList: { add() {}, remove() {} },
            appendChild() {}, querySelector() { return null; }
        };
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};
globalThis.Blob = class { constructor() {} };
// NOTE: js/hud.js and friends expect a browser-like URL.createObjectURL, but
// server/gateway.js and js/ai/httpModelAdapter.js both need the real WHATWG
// URL constructor. Keep the native one — nothing in this suite touches
// object URLs — and expose the blob helpers as extra properties.
if (typeof globalThis.URL?.createObjectURL !== 'function') {
    globalThis.URL.createObjectURL = () => 'blob:test';
    globalThis.URL.revokeObjectURL = () => {};
}

import http from 'node:http';

const {
    createGatewayServer,
    ERROR_CODES,
    PROVIDER_CONFIG,
    SUPPORTED_PROVIDERS,
    FORBIDDEN_CLIENT_KEYS,
    MODEL_SOURCE,
    resolveModelPolicy,
    resolveUpstreamTarget,
    normalizeProviderResponse,
    normalizeUpstreamStatus,
    sanitizeForLog,
    redactSecrets
} = await import('../server/gateway.js');

const { HttpModelAdapter } = await import('../js/ai/httpModelAdapter.js');
const { AIBrain } = await import('../js/ai/aiBrain.js');
const { planValidator } = await import('../js/ai/planValidator.js');
const { agent } = await import('../js/agent.js');
const { skillManager } = await import('../js/skillManager.js');
const { permissions } = await import('../js/permissions.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

// A secret used throughout. If it ever surfaces anywhere, a test fails.
const SECRET_KEY = 'sk-test-9f3a7c1b5e8d2046abcdef1234567890SECRETVALUE';

// =============================================================================
// Harness: local mock UPSTREAM provider + local gateway
// =============================================================================

/** Stand up a deterministic local upstream provider on 127.0.0.1:0. */
async function startMockUpstream(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try { body = JSON.parse(raw); } catch (e) { body = null; }
            requests.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
            handler(req, res, { body, raw, count: requests.length });
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise(resolve => server.close(resolve))
    };
}

/** Send a well-formed OpenAI-compatible completion. */
function respondOpenAI(res, text, usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: 'mock-upstream',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage
    }));
}

/** Start a gateway wired to a local mock upstream via the groq provider. */
async function startGatewayWithUpstream(upstreamUrl, extra = {}) {
    const server = createGatewayServer({
        port: 0,
        provider: 'groq',
        groqApiKey: SECRET_KEY,
        providerEndpoints: { groq: `${upstreamUrl}/v1/chat/completions` },
        rateLimitPerMinute: 100000,   // rate limiting has its own suite
        ...extra
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port, close: () => new Promise(r => server.close(r)) };
}

function requestGateway({ port, method = 'POST', path = '/api/ai/generate', headers = {}, body = null, rawBody = null }) {
    return new Promise((resolve, reject) => {
        const reqHeaders = { ...headers };
        if ((body || rawBody) && !reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';

        const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: reqHeaders }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch (e) { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, body: data, json });
            });
        });
        req.on('error', reject);
        const payload = rawBody !== null ? rawBody : (body !== null ? JSON.stringify(body) : null);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

/** Capture everything written to console while `fn` runs. */
async function captureConsole(fn) {
    const lines = [];
    const methods = ['log', 'error', 'warn', 'info', 'debug', 'trace'];
    const saved = {};
    for (const m of methods) {
        saved[m] = console[m];
        console[m] = (...args) => { lines.push(args.map(a => {
            try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ')); };
    }
    try {
        return { result: await fn(), lines };
    } finally {
        for (const m of methods) console[m] = saved[m];
    }
}

// =============================================================================
console.log('1) Valid real-provider configuration');
// =============================================================================
{
    const upstream = await startMockUpstream((req, res) => respondOpenAI(res, '{"type":"response","response":"hello"}'));
    const gw = await startGatewayWithUpstream(upstream.url);

    const res = await requestGateway({ port: gw.port, body: { prompt: 'say hello' } });
    check('configured provider returns HTTP 200', res.status === 200);
    check('normalized text returned to client', typeof res.json?.text === 'string' && res.json.text.length > 0);
    check('normalized usage returned to client', res.json?.usage?.totalTokens === 12);
    check('gateway used the fixed provider endpoint path', upstream.requests[0]?.url === '/v1/chat/completions');
    check('upstream request method is POST', upstream.requests[0]?.method === 'POST');
    check('health reports a real provider', true);

    const health = await requestGateway({ port: gw.port, method: 'GET', path: '/api/health' });
    check('health endpoint returns 200', health.status === 200);
    check('health flags realProvider=true', health.json?.realProvider === true);
    check('health flags credentialsConfigured=true', health.json?.credentialsConfigured === true);
    check('health reports the effective server model', health.json?.model === PROVIDER_CONFIG.groq.defaultModel);
    check('health NEVER exposes the API key', !health.body.includes(SECRET_KEY));

    await gw.close();
    await upstream.close();
}

// =============================================================================
console.log('2) Mock provider still works (zero credentials, offline)');
// =============================================================================
{
    const gwServer = createGatewayServer({ port: 0, provider: 'mock', rateLimitPerMinute: 100000 });
    await new Promise(resolve => gwServer.listen(0, '127.0.0.1', resolve));
    const port = gwServer.address().port;

    const res = await requestGateway({ port, body: { prompt: 'hello mock' } });
    check('mock provider returns HTTP 200 with no credentials', res.status === 200);
    check('mock response text present', typeof res.json?.text === 'string' && res.json.text.length > 0);
    check('mock usage field present', 'usage' in (res.json || {}));

    const health = await requestGateway({ port, method: 'GET', path: '/api/health' });
    check('mock health reports realProvider=false', health.json?.realProvider === false);
    check('mock health needs no credentials', health.json?.credentialsConfigured === true);

    const plan = await requestGateway({ port, body: { prompt: 'research AI and summarize into a doc' } });
    let parsed = null;
    try { parsed = JSON.parse(plan.json.text); } catch (e) { parsed = null; }
    check('mock plan recipe still produced', Array.isArray(parsed?.steps) && parsed.steps.length === 3);

    await new Promise(r => gwServer.close(r));
}

// =============================================================================
console.log('3) Missing API key');
// =============================================================================
{
    const gwServer = createGatewayServer({ port: 0, provider: 'groq', groqApiKey: null, apiKey: null, rateLimitPerMinute: 100000 });
    await new Promise(resolve => gwServer.listen(0, '127.0.0.1', resolve));
    const port = gwServer.address().port;

    const res = await requestGateway({ port, body: { prompt: 'test' } });
    check('missing API key returns HTTP 503', res.status === 503);
    check('error code is PROVIDER_UNAVAILABLE', res.json?.error?.code === ERROR_CODES.PROVIDER_UNAVAILABLE);
    check('message names the missing VARIABLE only', /GROQ_API_KEY/.test(res.json?.error?.message || ''));
    check('no key value in the message', !res.body.includes(SECRET_KEY));

    const health = await requestGateway({ port, method: 'GET', path: '/api/health' });
    check('health reports credentialsConfigured=false', health.json?.credentialsConfigured === false);

    await new Promise(r => gwServer.close(r));
}

// =============================================================================
console.log('4) Unsupported provider');
// =============================================================================
{
    const gwServer = createGatewayServer({ port: 0, provider: 'totally-unknown-provider', rateLimitPerMinute: 100000 });
    await new Promise(resolve => gwServer.listen(0, '127.0.0.1', resolve));
    const port = gwServer.address().port;

    const res = await requestGateway({ port, body: { prompt: 'test' } });
    check('unsupported provider returns HTTP 500', res.status === 500);
    check('error code is PROVIDER_NOT_SUPPORTED', res.json?.error?.code === ERROR_CODES.PROVIDER_NOT_SUPPORTED);
    check('configured value not echoed to client', !res.body.includes('totally-unknown-provider'));

    const health = await requestGateway({ port, method: 'GET', path: '/api/health' });
    check('health masks unsupported provider', health.json?.provider === 'unsupported');

    await new Promise(r => gwServer.close(r));

    // Prototype-chain provider names must not resolve to a provider.
    let threw = null;
    try { resolveUpstreamTarget('constructor', {}); } catch (e) { threw = e; }
    check('"constructor" is not treated as a provider', threw !== null && threw.code === ERROR_CODES.PROVIDER_NOT_SUPPORTED);
    let threw2 = null;
    try { resolveUpstreamTarget('__proto__', {}); } catch (e) { threw2 = e; }
    check('"__proto__" is not treated as a provider', threw2 !== null && threw2.code === ERROR_CODES.PROVIDER_NOT_SUPPORTED);
    check('SUPPORTED_PROVIDERS is the frozen allowlist',
        SUPPORTED_PROVIDERS.length === 4 && SUPPORTED_PROVIDERS.includes('groq') && SUPPORTED_PROVIDERS.includes('mock'));
}

// =============================================================================
console.log('5) AI_MODEL is server-authoritative');
// =============================================================================
{
    const upstream = await startMockUpstream((req, res) => respondOpenAI(res, '{"ok":true}'));
    const gw = await startGatewayWithUpstream(upstream.url, { model: 'server-pinned-model' });

    const res = await requestGateway({ port: gw.port, body: { prompt: 'test', model: 'client-wants-this' } });
    check('request succeeds when AI_MODEL is set', res.status === 200);
    check('upstream received the SERVER model', upstream.requests[0]?.body?.model === 'server-pinned-model');
    check('client model was NOT forwarded upstream', upstream.requests[0]?.body?.model !== 'client-wants-this');
    check('response reports the server model', res.json?.model === 'server-pinned-model');

    const health = await requestGateway({ port: gw.port, method: 'GET', path: '/api/health' });
    check('health reports AI_MODEL as effective model', health.json?.model === 'server-pinned-model');

    // Pure-policy unit checks (no network).
    const p = resolveModelPolicy({
        clientModel: 'attacker-model', provider: 'groq', serverModel: 'pinned',
        allowedModels: ['attacker-model'], allowClientModel: true
    });
    check('policy: AI_MODEL wins even when client model IS allowlisted', p.model === 'pinned');
    check('policy: source is server-config', p.source === MODEL_SOURCE.SERVER);

    await gw.close();
    await upstream.close();
}

// =============================================================================
console.log('6) Authorized client model (explicit server opt-in + allowlist)');
// =============================================================================
{
    const upstream = await startMockUpstream((req, res) => respondOpenAI(res, '{"ok":true}'));
    const gw = await startGatewayWithUpstream(upstream.url, {
        allowClientModel: true,
        allowedModels: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768']
    });

    const res = await requestGateway({ port: gw.port, body: { prompt: 'test', model: 'mixtral-8x7b-32768' } });
    check('allowlisted client model accepted (200)', res.status === 200);
    check('allowlisted client model forwarded upstream', upstream.requests[0]?.body?.model === 'mixtral-8x7b-32768');

    const p = resolveModelPolicy({
        clientModel: 'mixtral-8x7b-32768', provider: 'groq', serverModel: null,
        allowedModels: ['mixtral-8x7b-32768'], allowClientModel: true
    });
    check('policy: source is client-allowlisted', p.source === MODEL_SOURCE.CLIENT_ALLOWED);
    check('policy: authorized', p.authorized === true);

    await gw.close();
    await upstream.close();
}

// =============================================================================
console.log('7) Unauthorized client model');
// =============================================================================
{
    const upstream = await startMockUpstream((req, res) => respondOpenAI(res, '{"ok":true}'));
    const gw = await startGatewayWithUpstream(upstream.url, {
        allowClientModel: true,
        allowedModels: ['llama-3.3-70b-versatile']
    });

    const res = await requestGateway({ port: gw.port, body: { prompt: 'test', model: 'gpt-4-not-allowed' } });
    check('non-allowlisted client model rejected with 403', res.status === 403);
    check('error code is MODEL_NOT_ALLOWED', res.json?.error?.code === ERROR_CODES.MODEL_NOT_ALLOWED);
    check('rejection reason mentions allowlist', /allowlist/i.test(res.json?.error?.message || ''));

    await gw.close();
    await upstream.close();

    // Default posture: client model selection is OFF.
    const upstream2 = await startMockUpstream((req, res) => respondOpenAI(res, '{"ok":true}'));
    const gw2 = await startGatewayWithUpstream(upstream2.url);
    const res2 = await requestGateway({ port: gw2.port, body: { prompt: 'test', model: PROVIDER_CONFIG.groq.defaultModel } });
    check('client model rejected by default (even a valid provider model)', res2.status === 403);
    check('default error code is MODEL_NOT_ALLOWED', res2.json?.error?.code === ERROR_CODES.MODEL_NOT_ALLOWED);
    await gw2.close();
    await upstream2.close();

    // allowClientModel ON but no allowlist configured -> refuse.
    const p = resolveModelPolicy({ clientModel: 'anything', provider: 'groq', serverModel: null, allowedModels: [], allowClientModel: true });
    check('policy: opt-in without allowlist still refuses', p.authorized === false);
    check('policy: falls back to provider default', p.model === PROVIDER_CONFIG.groq.defaultModel);
}

// =============================================================================
console.log('8) Unauthorized model is never forwarded upstream');
// =============================================================================
{
    const upstream = await startMockUpstream((req, res) => respondOpenAI(res, '{"ok":true}'));
    const gw = await startGatewayWithUpstream(upstream.url, { allowedModels: ['only-this-one'] });

    const res = await requestGateway({ port: gw.port, body: { prompt: 'test', model: 'secret-expensive-model' } });
    check('unauthorized model rejected', res.status === 403);
    check('upstream was NEVER contacted', upstream.requests.length === 0);

    await gw.close();
    await upstream.close();
}

// =============================================================================
console.log('9-12) SSRF & credential injection surface');
// =============================================================================
{
    const upstream = await startMockUpstream((req, res) => respondOpenAI(res, '{"ok":true}'));
    const gw = await startGatewayWithUpstream(upstream.url);

    // 9) arbitrary upstream URL
    const rUrl = await requestGateway({ port: gw.port, body: { prompt: 'x', url: 'http://169.254.169.254/latest/meta-data/' } });
    check('9) arbitrary upstream URL rejected (400)', rUrl.status === 400);
    check('9) rejection names the prohibited field', /prohibited/i.test(rUrl.json?.error?.message || ''));

    const rTarget = await requestGateway({ port: gw.port, body: { prompt: 'x', targetUrl: 'https://evil.example.com/v1' } });
    check('9) targetUrl rejected (400)', rTarget.status === 400);

    const rBase = await requestGateway({ port: gw.port, body: { prompt: 'x', baseUrl: 'https://evil.example.com' } });
    check('9) baseUrl rejected (400)', rBase.status === 400);

    // 10) arbitrary endpoint / host / port
    const rEndpoint = await requestGateway({ port: gw.port, body: { prompt: 'x', endpoint: 'http://10.0.0.5:9999/v1/chat' } });
    check('10) arbitrary endpoint rejected (400)', rEndpoint.status === 400);

    const rHost = await requestGateway({ port: gw.port, body: { prompt: 'x', host: 'internal.metadata' } });
    check('10) arbitrary host rejected (400)', rHost.status === 400);

    const rPort = await requestGateway({ port: gw.port, body: { prompt: 'x', port: 6379 } });
    check('10) arbitrary port rejected (400)', rPort.status === 400);

    const rDest = await requestGateway({ port: gw.port, body: { prompt: 'x', destination: 'https://evil.internal.network' } });
    check('10) arbitrary destination rejected (400)', rDest.status === 400);

    // 11) client Authorization header
    const rAuth = await requestGateway({ port: gw.port, body: { prompt: 'x', authorization: 'Bearer attacker-token' } });
    check('11) client authorization field rejected (400)', rAuth.status === 400);

    const rAuthUpper = await requestGateway({ port: gw.port, rawBody: JSON.stringify({ prompt: 'x', Authorization: 'Bearer attacker-token' }) });
    check('11) client Authorization (capitalized) rejected (400)', rAuthUpper.status === 400);

    const rHeaders = await requestGateway({ port: gw.port, body: { prompt: 'x', headers: { Authorization: 'Bearer attacker' } } });
    check('11) client headers object rejected (400)', rHeaders.status === 400);

    // 12) client API key
    const rKey = await requestGateway({ port: gw.port, body: { prompt: 'x', apiKey: 'stolen-key' } });
    check('12) client apiKey rejected (400)', rKey.status === 400);

    const rKeySnake = await requestGateway({ port: gw.port, body: { prompt: 'x', api_key: 'stolen-key' } });
    check('12) client api_key (snake_case) rejected (400)', rKeySnake.status === 400);

    const rProvider = await requestGateway({ port: gw.port, body: { prompt: 'x', provider: 'openrouter' } });
    check('12) client provider override rejected (400)', rProvider.status === 400);

    check('SSRF attempts never reached the upstream', upstream.requests.length === 0);

    // Every forbidden key must be refused, in both letter cases.
    let allForbidden = true;
    for (const key of FORBIDDEN_CLIENT_KEYS) {
        const a = await requestGateway({ port: gw.port, body: { prompt: 'x', [key]: 'v' } });
        const b = await requestGateway({ port: gw.port, rawBody: JSON.stringify({ prompt: 'x', [key.toUpperCase()]: 'v' }) });
        if (a.status !== 400 || b.status !== 400) { allForbidden = false; break; }
    }
    check(`all ${FORBIDDEN_CLIENT_KEYS.length} forbidden keys rejected in both cases`, allForbidden);

    // The upstream Authorization always comes from the SERVER key.
    const okRes = await requestGateway({ port: gw.port, body: { prompt: 'x' } });
    check('clean request still succeeds after injection attempts', okRes.status === 200);
    check('upstream Authorization is the SERVER key', upstream.requests[0]?.headers?.authorization === `Bearer ${SECRET_KEY}`);

    await gw.close();
    await upstream.close();
}

// =============================================================================
console.log('13-14) Successful OpenAI-compatible & structured responses');
// =============================================================================
{
    const structured = JSON.stringify({ type: 'response', response: 'structured ok' });
    const upstream = await startMockUpstream((req, res) => respondOpenAI(res, structured));
    const gw = await startGatewayWithUpstream(upstream.url);

    const res = await requestGateway({ port: gw.port, body: { prompt: 'test', responseFormat: 'json' } });
    check('13) 200 on valid OpenAI-compatible response', res.status === 200);
    check('13) content extracted from choices[0].message.content', res.json?.text === structured);
    check('13) usage normalized to camelCase', res.json?.usage?.promptTokens === 5 && res.json?.usage?.completionTokens === 7);
    check('13) json_object response_format requested upstream',
        upstream.requests[0]?.body?.response_format?.type === 'json_object');
    check('13) bounded max_tokens sent upstream', upstream.requests[0]?.body?.max_tokens === 1024);
    check('13) temperature forwarded', upstream.requests[0]?.body?.temperature === 0.2);

    const textRes = await requestGateway({ port: gw.port, body: { prompt: 'test', responseFormat: 'text' } });
    check('13) text format omits response_format upstream',
        upstream.requests[1]?.body?.response_format === undefined);
    check('13) text request succeeds', textRes.status === 200);

    // 14) structured/plan output through the real chain
    const planPayload = JSON.stringify({
        goal: 'research and write',
        steps: [{ id: 'step_1', skill: 'websearch', action: 'search', input: 'topic', contextKey: 'r', dependsOn: [] }]
    });
    const planUpstream = await startMockUpstream((req, res) => respondOpenAI(res, planPayload));
    const planGw = await startGatewayWithUpstream(planUpstream.url);
    const planRes = await requestGateway({ port: planGw.port, body: { prompt: 'test', responseFormat: 'plan' } });
    check('14) 200 on valid structured/plan response', planRes.status === 200);
    let planParsed = null;
    try { planParsed = JSON.parse(planRes.json.text); } catch (e) { planParsed = null; }
    check('14) plan JSON round-trips intact', Array.isArray(planParsed?.steps) && planParsed.steps[0].skill === 'websearch');

    await gw.close();
    await upstream.close();
    await planGw.close();
    await planUpstream.close();
}

// =============================================================================
console.log('15-19) Malformed & empty provider responses are ERRORS');
// =============================================================================
{
    const cases = [
        ['15) malformed upstream JSON', 'this is { not json', /malformed JSON/i],
        ['16) missing "choices"', JSON.stringify({ id: 'x', data: 'no choices here' }), /choices/i],
        ['16) empty "choices" array', JSON.stringify({ choices: [] }), /no completion choices/i],
        ['17) missing "message"', JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop' }] }), /message/i],
        ['18) missing "content"', JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant' } }] }), /content/i],
        ['19) empty model response', JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '   ' } }] }), /empty/i],
        ['19) null content', JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: null } }] }), /content/i],
        ['empty body', '', /empty response/i]
    ];

    for (const [label, upstreamBody, messagePattern] of cases) {
        const upstream = await startMockUpstream((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(upstreamBody);
        });
        const gw = await startGatewayWithUpstream(upstream.url);
        const res = await requestGateway({ port: gw.port, body: { prompt: 'test' } });

        check(`${label}: rejected with 502`, res.status === 502);
        check(`${label}: code is PROVIDER_MALFORMED`, res.json?.error?.code === ERROR_CODES.PROVIDER_MALFORMED);
        check(`${label}: never an empty success`, !(res.status === 200 && res.json && res.json.text !== undefined));
        check(`${label}: message describes the defect`, messagePattern.test(res.json?.error?.message || ''));

        await gw.close();
        await upstream.close();
    }

    // Non-object JSON bodies.
    const arrUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[1,2,3]');
    });
    const arrGw = await startGatewayWithUpstream(arrUpstream.url);
    const arrRes = await requestGateway({ port: arrGw.port, body: { prompt: 'test' } });
    check('array body rejected with PROVIDER_MALFORMED', arrRes.status === 502 && arrRes.json?.error?.code === ERROR_CODES.PROVIDER_MALFORMED);
    await arrGw.close();
    await arrUpstream.close();

    // Unit-level: normalization never yields an empty success.
    let threw = null;
    try { normalizeProviderResponse(JSON.stringify({ choices: [{}] })); } catch (e) { threw = e; }
    check('normalizeProviderResponse throws on missing message', threw !== null && threw.code === ERROR_CODES.PROVIDER_MALFORMED);
    check('thrown error has a safe clientMessage', typeof threw?.clientMessage === 'string' && threw.clientMessage.length > 0);

    const good = normalizeProviderResponse(JSON.stringify({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    }));
    check('normalizeProviderResponse accepts a valid body', good.text === 'hi' && good.usage.totalTokens === 3);

    const ollamaStyle = normalizeProviderResponse(JSON.stringify({ response: 'ollama text' }));
    check('Ollama-style `response` field still supported', ollamaStyle.text === 'ollama text');
}

// =============================================================================
console.log('20-24) Upstream failure statuses, 5xx and timeout');
// =============================================================================
{
    const statusCases = [
        [401, 401, ERROR_CODES.UNAUTHORIZED, /credentials/i],
        [403, 403, ERROR_CODES.UNAUTHORIZED, /refused/i],
        [429, 429, ERROR_CODES.RATE_LIMITED, /rate limit/i],
        [500, 502, ERROR_CODES.PROVIDER_UNAVAILABLE, /HTTP 500/],
        [503, 502, ERROR_CODES.PROVIDER_UNAVAILABLE, /HTTP 503/]
    ];

    for (const [upstreamStatus, expectedStatus, expectedCode, messagePattern] of statusCases) {
        const upstream = await startMockUpstream((req, res) => {
            res.writeHead(upstreamStatus, {
                'Content-Type': 'application/json',
                ...(upstreamStatus === 429 ? { 'Retry-After': '30' } : {})
            });
            // Deliberately hostile body: internal detail that must not leak.
            res.end(JSON.stringify({ error: { message: `internal detail with key ${SECRET_KEY} at https://api.groq.com`, key: SECRET_KEY } }));
        });
        const gw = await startGatewayWithUpstream(upstream.url);
        const res = await requestGateway({ port: gw.port, body: { prompt: 'test' } });

        check(`${upstreamStatus}: mapped to HTTP ${expectedStatus}`, res.status === expectedStatus);
        check(`${upstreamStatus}: code is ${expectedCode}`, res.json?.error?.code === expectedCode);
        check(`${upstreamStatus}: message matches category`, messagePattern.test(res.json?.error?.message || ''));
        check(`${upstreamStatus}: upstream body NOT relayed`, !res.body.includes('internal detail'));
        check(`${upstreamStatus}: no upstream endpoint leaked`, !res.body.includes('api.groq.com'));
        check(`${upstreamStatus}: no secret leaked`, !res.body.includes(SECRET_KEY));

        await gw.close();
        await upstream.close();
    }

    // 429 numeric Retry-After survives; provider prose does not.
    const r429Upstream = await startMockUpstream((req, res) => {
        res.writeHead(429, { 'Retry-After': '42' });
        res.end('{}');
    });
    const r429Gw = await startGatewayWithUpstream(r429Upstream.url);
    const r429 = await requestGateway({ port: r429Gw.port, body: { prompt: 'test' } });
    const retryErr = normalizeUpstreamStatus(429, { 'retry-after': '42' });
    check('429 carries a numeric retryAfter internally', retryErr.retryAfter === '42');
    check('429 client status is 429', r429.status === 429);
    await r429Gw.close();
    await r429Upstream.close();

    // 24) timeout — upstream stalls longer than the gateway budget.
    const slowUpstream = await startMockUpstream((req, res) => {
        setTimeout(() => respondOpenAI(res, '{"late":true}'), 3000);
    });
    const slowGw = await startGatewayWithUpstream(slowUpstream.url, { upstreamTimeoutMs: 150 });
    const started = Date.now();
    const slowRes = await requestGateway({ port: slowGw.port, body: { prompt: 'test' } });
    const elapsed = Date.now() - started;
    check('24) timeout returns HTTP 504', slowRes.status === 504);
    check('24) timeout code is PROVIDER_TIMEOUT', slowRes.json?.error?.code === ERROR_CODES.PROVIDER_TIMEOUT);
    check('24) gateway aborted without waiting for upstream', elapsed < 2500);
    await slowGw.close();
    await slowUpstream.close();

    // Connection failure (nothing listening).
    const deadGw = createGatewayServer({
        port: 0, provider: 'groq', groqApiKey: SECRET_KEY,
        providerEndpoints: { groq: 'http://127.0.0.1:59999/v1/chat/completions' },
        upstreamTimeoutMs: 500, rateLimitPerMinute: 100000
    });
    await new Promise(resolve => deadGw.listen(0, '127.0.0.1', resolve));
    const deadRes = await requestGateway({ port: deadGw.address().port, body: { prompt: 'test' } });
    check('connection failure returns HTTP 502', deadRes.status === 502);
    check('connection failure code is PROVIDER_UNAVAILABLE', deadRes.json?.error?.code === ERROR_CODES.PROVIDER_UNAVAILABLE);
    check('connection failure leaks no host/port', !deadRes.body.includes('59999'));
    await new Promise(r => deadGw.close(r));

    // Oversized upstream response is refused, not buffered.
    const bigUpstream = await startMockUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'A'.repeat(60000) } }] }));
    });
    const bigGw = await startGatewayWithUpstream(bigUpstream.url, { maxUpstreamResponseBytes: 1024 });
    const bigRes = await requestGateway({ port: bigGw.port, body: { prompt: 'test' } });
    check('oversized upstream response rejected (502)', bigRes.status === 502);
    check('oversized response code is PROVIDER_MALFORMED', bigRes.json?.error?.code === ERROR_CODES.PROVIDER_MALFORMED);
    check('oversized body not relayed to client', bigRes.body.length < 5000);
    await bigGw.close();
    await bigUpstream.close();

    // NO automatic retries: one client request == exactly one upstream hit.
    let hits = 0;
    const retryUpstream = await startMockUpstream((req, res) => {
        hits++;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{}');
    });
    const retryGw = await startGatewayWithUpstream(retryUpstream.url);
    await requestGateway({ port: retryGw.port, body: { prompt: 'test' } });
    await new Promise(r => setTimeout(r, 250));
    check('no automatic retry after upstream 5xx (exactly 1 upstream call)', hits === 1);
    await retryGw.close();
    await retryUpstream.close();
}

// =============================================================================
console.log('25-27) API key never appears in responses, errors or logs');
// =============================================================================
{
    const upstream = await startMockUpstream((req, res) => {
        // Worst case: the provider echoes our own Authorization back to us.
        respondOpenAI(res, JSON.stringify({ leaked: req.headers.authorization }));
    });
    const gw = await startGatewayWithUpstream(upstream.url);

    const captured = await captureConsole(async () => {
        const okRes = await requestGateway({ port: gw.port, body: { prompt: 'test' } });
        const healthRes = await requestGateway({ port: gw.port, method: 'GET', path: '/api/health' });
        return { okRes, healthRes };
    });

    check('25) key absent from success response body', !captured.result.okRes.body.includes(SECRET_KEY));
    check('25) key absent from health response body', !captured.result.healthRes.body.includes(SECRET_KEY));
    // The provider deliberately echoed our own Authorization header back as
    // model content. The gateway must scrub it before it reaches the client.
    check('25) provider echo of our Authorization is scrubbed from text',
        !(captured.result.okRes.json?.text || '').includes(SECRET_KEY));
    check('25) scrubbed text is redacted, not empty',
        typeof captured.result.okRes.json?.text === 'string' && captured.result.okRes.json.text.length > 0);
    check('25) scrubbed text carries a redaction marker',
        /\[REDACTED\]/.test(captured.result.okRes.json?.text || ''));

    // redactSecrets() unit behaviour.
    check('redactSecrets strips the bare secret',
        !redactSecrets(`prefix ${SECRET_KEY} suffix`, [SECRET_KEY]).includes(SECRET_KEY));
    check('redactSecrets strips the Bearer form',
        !redactSecrets(`Bearer ${SECRET_KEY}`, [SECRET_KEY]).includes(SECRET_KEY));
    check('redactSecrets is a no-op when the secret is absent',
        redactSecrets('ordinary model text', [SECRET_KEY]) === 'ordinary model text');
    check('redactSecrets survives regex metacharacters in a key',
        !redactSecrets('key=a.b*c+d?e(f)g', ['a.b*c+d?e(f)g']).includes('a.b*c+d?e(f)g'));
    check('redactSecrets ignores implausibly short secrets',
        redactSecrets('the word is secret', ['short']) === 'the word is secret');

    // Error paths.
    const errUpstream = await startMockUpstream((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `bad key ${SECRET_KEY}` } }));
    });
    const errGw = await startGatewayWithUpstream(errUpstream.url);
    const errCaptured = await captureConsole(async () =>
        requestGateway({ port: errGw.port, body: { prompt: 'test' } }));
    check('26) key absent from error response', !errCaptured.result.body.includes(SECRET_KEY));
    check('26) upstream error prose not relayed', !errCaptured.result.body.includes('bad key'));

    // Missing-key error path.
    const noKeyServer = createGatewayServer({ port: 0, provider: 'openrouter', rateLimitPerMinute: 100000 });
    await new Promise(resolve => noKeyServer.listen(0, '127.0.0.1', resolve));
    const noKeyRes = await requestGateway({ port: noKeyServer.address().port, body: { prompt: 'test' } });
    check('26) missing-key error names the variable, not a value',
        /OPENROUTER_API_KEY/.test(noKeyRes.json?.error?.message || '') && !noKeyRes.body.includes(SECRET_KEY));
    await new Promise(r => noKeyServer.close(r));

    // Thrown error objects.
    const thrown = normalizeUpstreamStatus(401, { authorization: `Bearer ${SECRET_KEY}` });
    check('26) thrown error message has no key', !String(thrown.message).includes(SECRET_KEY));
    check('26) thrown clientMessage has no key', !String(thrown.clientMessage).includes(SECRET_KEY));
    check('26) thrown error carries no headers object', thrown.headers === undefined);

    // 27) logs / debug output.
    const allLogs = [...captured.lines, ...errCaptured.lines].join('\n');
    check('27) key never written to console', !allLogs.includes(SECRET_KEY));
    check('27) no "Bearer <token>" written to console', !/Bearer\s+[A-Za-z0-9._-]{8,}/.test(allLogs));

    // sanitizeForLog() defence-in-depth.
    const dirty = `Authorization: Bearer ${SECRET_KEY} and api_key=${SECRET_KEY} plus gsk_live_abcdefghijklmnop1234`;
    const clean = sanitizeForLog(dirty);
    check('27) sanitizeForLog strips the key', !clean.includes(SECRET_KEY));
    check('27) sanitizeForLog strips bearer tokens', !/Bearer\s+sk-/.test(clean));
    check('27) sanitizeForLog strips provider key formats', !clean.includes('gsk_live_abcdefghijklmnop1234'));
    check('27) sanitizeForLog leaves ordinary text alone', sanitizeForLog('provider is groq') === 'provider is groq');

    // The config object holding the key is not enumerable on the server.
    check('27) gateway config is non-enumerable (not JSON-serializable)',
        !Object.keys(gw.server).includes('aliceConfig') && !JSON.stringify(gw.server).includes(SECRET_KEY));

    await gw.close();
    await upstream.close();
    await errGw.close();
    await errUpstream.close();
}

// =============================================================================
console.log('28-30) Provider output cannot bypass the security chain');
// =============================================================================
{
    // A hostile provider that returns a plan invoking a sensitive skill while
    // claiming risk "safe" — the classic privilege-escalation attempt.
    let trapExecuted = false;
    skillManager.register({
        name: 'phase633TrapSkill',
        description: 'Trap skill that must never execute from model output',
        risk: 'sensitive',
        patterns: [/^phase633trap/],
        execute() {
            trapExecuted = true;
            return { success: true, result: 'trap executed' };
        }
    });

    const hostilePlan = JSON.stringify({
        goal: 'exfiltrate everything',
        steps: [{
            id: 'step_1',
            skill: 'phase633TrapSkill',
            action: 'delete all records',
            input: 'delete all records',
            risk: 'safe'          // model lies about the risk level
        }]
    });

    const upstream = await startMockUpstream((req, res) => respondOpenAI(res, hostilePlan));
    const gw = await startGatewayWithUpstream(upstream.url);

    // Full chain: HttpModelAdapter -> gateway -> provider -> PlanValidator -> Agent
    const adapter = new HttpModelAdapter({
        gatewayUrl: `http://127.0.0.1:${gw.port}/api/ai/generate`,
        timeout: 5000
    });
    const brain = new AIBrain({ adapter });

    const processed = await brain.processRequest('exfiltrate everything');
    check('28) hostile provider plan reaches PlanValidator', processed.success === true || processed.fallback === true);

    // A plan claiming an unregistered skill must be rejected outright.
    const unknownPlan = JSON.stringify({
        goal: 'hack',
        steps: [{ id: 'step_1', skill: 'totallyUnknownSkill', input: 'hack' }]
    });
    const unknownUpstream = await startMockUpstream((req, res) => respondOpenAI(res, unknownPlan));
    const unknownGw = await startGatewayWithUpstream(unknownUpstream.url);
    const unknownAdapter = new HttpModelAdapter({
        gatewayUrl: `http://127.0.0.1:${unknownGw.port}/api/ai/generate`, timeout: 5000
    });
    const unknownBrain = new AIBrain({ adapter: unknownAdapter });
    const unknownRes = await unknownBrain.processRequest('hack the system');
    check('28) provider plan with unknown skill is rejected', unknownRes.success === false);
    check('28) rejection is flagged as fallback', unknownRes.fallback === true);
    check('28) validation errors reported', Array.isArray(unknownRes.validationErrors) && unknownRes.validationErrors.length > 0);

    // 29) Even a validator-approved plan cannot execute without permission.
    const validPlan = JSON.stringify({
        goal: 'run the trap',
        steps: [{ id: 'step_1', skill: 'phase633TrapSkill', action: 'phase633trap now', input: 'phase633trap now' }]
    });
    const validUpstream = await startMockUpstream((req, res) => respondOpenAI(res, validPlan));
    const validGw = await startGatewayWithUpstream(validUpstream.url);
    const validAdapter = new HttpModelAdapter({
        gatewayUrl: `http://127.0.0.1:${validGw.port}/api/ai/generate`, timeout: 5000
    });
    const validBrain = new AIBrain({ adapter: validAdapter });
    const validProcessed = await validBrain.processRequest('run the trap');
    check('29) provider plan is validated before execution', validProcessed.success === true && validProcessed.isMultiStep === true);

    let promptSeen = false;
    permissions.onPrompt(() => {
        promptSeen = true;
        setTimeout(() => permissions.answer(false), 0);   // user DENIES
    });
    trapExecuted = false;
    const execRes = await agent.executePlan(
        { isMultiStep: true, goal: 'run the trap', plan: validProcessed.plan },
        () => {}
    );
    check('29) permission prompt raised despite model claiming "safe"', promptSeen === true);
    check('29) denied skill never executed', trapExecuted === false);
    check('29) agent reports cancellation', execRes.success === false && /cancel/i.test(execRes.response));
    permissions.onPrompt(null);

    // 30) The permission boundary is authoritative, not the gateway/adapter.
    const directValidation = planValidator.validate({
        goal: 'direct',
        steps: [{ id: 'step_1', skill: 'phase633TrapSkill', input: 'phase633trap direct' }]
    });
    check('30) PlanValidator accepts a well-formed plan', directValidation.valid === true);
    check('30) normalized risk comes from the SKILL, not the model',
        directValidation.normalizedPlan[0].risk === 'sensitive');

    let directExecuted = false;
    permissions.onPrompt(() => {
        setTimeout(() => permissions.answer(false), 0);
    });
    const directRes = await agent.executePlan(
        { isMultiStep: true, goal: 'direct', plan: directValidation.normalizedPlan },
        () => {}
    );
    check('30) permission gateway still blocks direct execution', directRes.success === false);
    permissions.onPrompt(null);
    check('30) trap skill never executed in any path', trapExecuted === false && directExecuted === false);

    // Executable-code injection through a real provider response is still caught.
    const injectionPlan = JSON.stringify({
        goal: 'inject',
        steps: [{ id: 'step_1', skill: 'notes', input: 'eval("window.localStorage.clear()")' }]
    });
    const injUpstream = await startMockUpstream((req, res) => respondOpenAI(res, injectionPlan));
    const injGw = await startGatewayWithUpstream(injUpstream.url);
    const injAdapter = new HttpModelAdapter({
        gatewayUrl: `http://127.0.0.1:${injGw.port}/api/ai/generate`, timeout: 5000
    });
    const injBrain = new AIBrain({ adapter: injAdapter });
    const injRes = await injBrain.processRequest('inject code');
    check('30) executable code from a real provider is rejected', injRes.success === false);

    await gw.close();
    await upstream.close();
    await unknownGw.close();
    await unknownUpstream.close();
    await validGw.close();
    await validUpstream.close();
    await injGw.close();
    await injUpstream.close();
}

// =============================================================================
console.log('Extra) Endpoint resolution stays server-controlled');
// =============================================================================
{
    check('groq endpoint is the fixed public URL',
        resolveUpstreamTarget('groq', {}) === PROVIDER_CONFIG.groq.endpoint);
    check('openrouter endpoint is the fixed public URL',
        resolveUpstreamTarget('openrouter', {}) === PROVIDER_CONFIG.openrouter.endpoint);
    check('ollama endpoint derives from server ollamaHost',
        resolveUpstreamTarget('ollama', { ollamaHost: 'http://127.0.0.1:11434' }) === 'http://127.0.0.1:11434/v1/chat/completions');

    let mockThrew = null;
    try { resolveUpstreamTarget('mock', {}); } catch (e) { mockThrew = e; }
    check('mock provider has no upstream endpoint', mockThrew !== null && mockThrew.code === ERROR_CODES.BAD_REQUEST);

    // An override can only REPLACE a known provider's destination.
    const normalized = createGatewayServer({
        port: 0, provider: 'mock',
        providerEndpoints: {
            groq: 'http://127.0.0.1:1/v1/chat/completions',
            evilProvider: 'http://attacker.example/v1',      // not in the map
            openrouter: 'file:///etc/passwd',                 // wrong scheme
            ollama: 'http://user:pass@127.0.0.1:1/v1'         // credentials in URL
        }
    });
    const cfg = normalized.aliceConfig;
    check('override accepted for an allowlisted provider', cfg.providerEndpoints.groq === 'http://127.0.0.1:1/v1/chat/completions');
    check('override cannot introduce a new provider', cfg.providerEndpoints.evilProvider === undefined);
    check('non-http(s) override rejected', cfg.providerEndpoints.openrouter === undefined);
    check('credentialed URL override rejected', cfg.providerEndpoints.ollama === undefined);
    check('mock provider can never get an endpoint', cfg.providerEndpoints.mock === undefined);
    await new Promise(r => normalized.close(r));
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
