// Tests for Phase 6.3.4 — minimal secure CORS on the local AI gateway.
// ------------------------------------------------------------------
// The local development setup is two origins: the ALICE0 frontend is
// served from http://localhost:8080 (or http://127.0.0.1:8080) while the
// gateway listens on http://127.0.0.1:3001, so the browser needs CORS for
// exactly ONE endpoint: POST /api/ai/generate.
//
// Contract verified here:
//   1. The DEFAULT allowlist is EXACTLY the two local ALICE0 development
//      frontend origins (server-side only; never request-controlled).
//   2. Allowed origins get an exact origin echo on the AI gateway endpoint
//      — never `*`, never a reflected arbitrary origin.
//   3. Arbitrary/external origins are refused (403) with NO CORS headers,
//      on both preflight and actual requests.
//   4. OPTIONS preflight returns 204 with only the headers a browser POST
//      needs.
//   5. Normal POST behavior is unchanged: same 200 envelope, same
//      content-type validation, same forbidden-key rejection, same
//      POST-only method policy.
//   6. CORS is scoped to the AI gateway endpoint only (/api/health stays
//      same-origin/curl territory).
//
// Everything runs against the REAL gateway server (server/gateway.js) with
// its zero-network mock provider on an ephemeral loopback port.
import http from 'node:http';
import { createGatewayServer, ERROR_CODES } from '../server/gateway.js';

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

function requestGateway({ port, method = 'POST', path = '/api/ai/generate', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const reqHeaders = { ...headers };
        if (body && !reqHeaders['Content-Type']) {
            reqHeaders['Content-Type'] = 'application/json';
        }
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: reqHeaders
        }, (res) => {
            let resData = '';
            res.on('data', chunk => { resData += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(resData); } catch (e) { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, body: resData, json });
            });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function startTestGateway(config = {}) {
    const server = createGatewayServer({ port: 0, provider: 'mock', ...config });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const close = () => new Promise(resolve => server.close(resolve));
    return { server, port, close };
}

// The two origins the local ALICE0 development frontend actually uses.
const FRONTEND_ORIGIN_HTTP = 'http://localhost:8080';
const FRONTEND_ORIGIN_LOOPBACK = 'http://127.0.0.1:8080';
const EVIL_ORIGIN = 'https://evil-attacker.example';

// ==================================================================
// A) Default origin allowlist is exactly the local dev frontends
// ==================================================================
console.log('A) Default CORS allowlist');
{
    const gw = await startTestGateway();
    const origins = gw.server.aliceConfig.allowedOrigins;
    check('default allowlist is exactly the two local ALICE0 frontend origins',
        Array.isArray(origins) && origins.length === 2 &&
        origins.includes(FRONTEND_ORIGIN_HTTP) && origins.includes(FRONTEND_ORIGIN_LOOPBACK));
    check('allowlist contains no wildcard entry', origins.every(o => o !== '*'));
    await gw.close();
}

// ==================================================================
// B) Allowed origins: exact echo on the AI gateway endpoint
// ==================================================================
console.log('B) Allowed local frontend origins');
const gw = await startTestGateway();
{
    const res = await requestGateway({
        port: gw.port,
        headers: { Origin: FRONTEND_ORIGIN_HTTP },
        body: { prompt: 'What is the capital of India?', responseFormat: 'text' }
    });
    check('POST with Origin http://localhost:8080 is allowed (HTTP 200)', res.status === 200);
    check('Access-Control-Allow-Origin echoes the exact allowed origin',
        res.headers['access-control-allow-origin'] === FRONTEND_ORIGIN_HTTP);
    check('wildcard CORS is never used', res.headers['access-control-allow-origin'] !== '*');
    check('normal POST response envelope unchanged', typeof res.json?.text === 'string' && 'usage' in res.json && typeof res.json.model === 'string');
}

{
    const res = await requestGateway({
        port: gw.port,
        headers: { Origin: FRONTEND_ORIGIN_LOOPBACK },
        body: { prompt: 'ping', responseFormat: 'text' }
    });
    check('POST with Origin http://127.0.0.1:8080 is allowed (HTTP 200)', res.status === 200);
    check('Access-Control-Allow-Origin echoes http://127.0.0.1:8080 exactly',
        res.headers['access-control-allow-origin'] === FRONTEND_ORIGIN_LOOPBACK);
}

// ==================================================================
// C) OPTIONS / preflight behaviour (allowed origins)
// ==================================================================
console.log('C) Preflight (OPTIONS)');
for (const origin of [FRONTEND_ORIGIN_HTTP, FRONTEND_ORIGIN_LOOPBACK]) {
    const res = await requestGateway({
        port: gw.port,
        method: 'OPTIONS',
        headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type'
        }
    });
    check(`preflight from ${origin} returns 204`, res.status === 204);
    check(`preflight from ${origin} echoes the exact origin`,
        res.headers['access-control-allow-origin'] === origin);
    check(`preflight from ${origin} allows the POST method`,
        String(res.headers['access-control-allow-methods']).includes('POST'));
    check(`preflight from ${origin} allows Content-Type`,
        String(res.headers['access-control-allow-headers']).toLowerCase().includes('content-type'));
    check(`preflight from ${origin} allows the optional local trust token header`,
        String(res.headers['access-control-allow-headers']).includes('X-Local-Trust-Token'));
    check(`preflight from ${origin} never uses wildcard origin`,
        res.headers['access-control-allow-origin'] !== '*');
}

// ==================================================================
// D) Arbitrary external origins are rejected, never reflected
// ==================================================================
console.log('D) Disallowed origins');
{
    const res = await requestGateway({
        port: gw.port,
        headers: { Origin: EVIL_ORIGIN },
        body: { prompt: 'test', responseFormat: 'text' }
    });
    check('POST from an arbitrary external origin is rejected with 403', res.status === 403);
    check('rejected origin gets NO Access-Control-Allow-Origin header',
        res.headers['access-control-allow-origin'] === undefined);
    check('rejected origin error code is UNAUTHORIZED', res.json?.error?.code === ERROR_CODES.UNAUTHORIZED);
    check('rejected origin is not echoed anywhere in the response body', !res.body.includes(EVIL_ORIGIN));

    const pre = await requestGateway({
        port: gw.port,
        method: 'OPTIONS',
        headers: {
            Origin: EVIL_ORIGIN,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type'
        }
    });
    check('preflight from an arbitrary external origin is rejected with 403', pre.status === 403);
    check('rejected preflight gets no CORS headers', pre.headers['access-control-allow-origin'] === undefined);
}

{
    // Exact-match enforcement: a hostname that merely CONTAINS an allowed
    // origin as a substring must not pass.
    const res = await requestGateway({
        port: gw.port,
        headers: { Origin: 'http://localhost:8080.attacker.example' },
        body: { prompt: 'test', responseFormat: 'text' }
    });
    check('lookalike origin (allowed string as prefix) is rejected with 403', res.status === 403);
    check('lookalike origin is not reflected', res.headers['access-control-allow-origin'] === undefined);
}

// ==================================================================
// E) CORS is scoped to the AI gateway endpoint only
// ==================================================================
console.log('E) CORS scoping');
{
    const res = await requestGateway({
        port: gw.port,
        method: 'GET',
        path: '/api/health',
        headers: { Origin: FRONTEND_ORIGIN_HTTP }
    });
    check('health endpoint stays reachable for allowed origin (HTTP 200)', res.status === 200);
    check('health endpoint emits no CORS headers (only /api/ai/generate needs them)',
        res.headers['access-control-allow-origin'] === undefined);
}

// ==================================================================
// F) Normal gateway behaviour is unchanged
// ==================================================================
console.log('F) Normal POST behaviour unchanged');
{
    // No Origin header at all (curl-style / same-origin clients).
    const res = await requestGateway({
        port: gw.port,
        body: { prompt: 'research quantum computing and summarize' }
    });
    check('request without Origin (curl-style) works exactly as before', res.status === 200);
    check('response envelope unchanged for non-browser clients',
        typeof res.json?.text === 'string' && 'usage' in res.json);

    const badCt = await requestGateway({
        port: gw.port,
        headers: { 'Content-Type': 'text/plain', Origin: FRONTEND_ORIGIN_HTTP },
        body: 'plain text'
    });
    check('content-type validation unchanged (400 for non-JSON)', badCt.status === 400);
    check('content-type error code unchanged', badCt.json?.error?.code === ERROR_CODES.BAD_REQUEST);

    const forbiddenKey = await requestGateway({
        port: gw.port,
        headers: { Origin: FRONTEND_ORIGIN_HTTP },
        body: { prompt: 'test', apiKey: 'stolen_key' }
    });
    check('forbidden client key check unchanged (400)', forbiddenKey.status === 400);

    const forbiddenKeyAllowedOrigin = await requestGateway({
        port: gw.port,
        headers: { Origin: FRONTEND_ORIGIN_LOOPBACK },
        body: { prompt: 'test', authorization: 'Bearer stolen' }
    });
    check('forbidden Authorization client key still rejected for allowed origin (400)',
        forbiddenKeyAllowedOrigin.status === 400);

    const wrongMethod = await requestGateway({
        port: gw.port,
        method: 'GET',
        headers: { Origin: FRONTEND_ORIGIN_HTTP }
    });
    check('generate endpoint remains POST-only (405 for GET)', wrongMethod.status === 405);
    check('Allow header unchanged', wrongMethod.headers.allow === 'POST, OPTIONS');
    check('405 for allowed origin still carries CORS (browser-visible response)',
        wrongMethod.headers['access-control-allow-origin'] === FRONTEND_ORIGIN_HTTP);
}

await gw.close();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
