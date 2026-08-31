// Tests for Secure Local AI Gateway (Phase 6.3.1)
import http from 'node:http';
import { createGatewayServer, ERROR_CODES } from '../server/gateway.js';

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

// Helper to make HTTP request to gateway
function requestGateway({ port, method = 'POST', path = '/api/ai/generate', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const reqHeaders = {
            ...headers
        };

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
                try {
                    json = JSON.parse(resData);
                } catch (e) {
                    json = null;
                }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: resData,
                    json
                });
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

// Start test gateway instance on ephemeral port (port: 0)
async function startTestGateway(config = {}) {
    const server = createGatewayServer({
        port: 0,
        provider: 'mock',
        ...config
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const close = () => new Promise(resolve => server.close(resolve));
    return { server, port, close };
}

// ==================================================================
// Test Suite Execution
// ==================================================================

console.log('1) Valid Request & Response Normalization');
const gw1 = await startTestGateway({ provider: 'mock' });

const resValid = await requestGateway({
    port: gw1.port,
    body: { prompt: 'research quantum computing and summarize' }
});

check('valid request returns HTTP 200', resValid.status === 200);
check('response contains text field', typeof resValid.json?.text === 'string' && resValid.json.text.length > 0);
check('response contains normalized usage field', 'usage' in (resValid.json || {}));
check('no internal server credentials leaked', !JSON.stringify(resValid.json).includes('sk-') && !JSON.stringify(resValid.json).includes('key'));

await gw1.close();

console.log('2) Invalid Method Handling');
const gw2 = await startTestGateway();

const resGet = await requestGateway({
    port: gw2.port,
    method: 'GET',
    path: '/api/ai/generate'
});
check('GET on /api/ai/generate rejected with HTTP 405', resGet.status === 405);
check('error code is METHOD_NOT_ALLOWED', resGet.json?.error?.code === ERROR_CODES.METHOD_NOT_ALLOWED);

const resPut = await requestGateway({
    port: gw2.port,
    method: 'PUT',
    path: '/api/ai/generate',
    body: { prompt: 'test' }
});
check('PUT on /api/ai/generate rejected with HTTP 405', resPut.status === 405);

await gw2.close();

console.log('3) Invalid Route Handling');
const gw3 = await startTestGateway();

const resRoute = await requestGateway({
    port: gw3.port,
    path: '/api/unknown/endpoint',
    body: { prompt: 'test' }
});
check('unknown path returns HTTP 404', resRoute.status === 404);
check('error code is NOT_FOUND', resRoute.json?.error?.code === ERROR_CODES.NOT_FOUND);

// Health check
const resHealth = await requestGateway({
    port: gw3.port,
    method: 'GET',
    path: '/api/health'
});
check('health check returns HTTP 200', resHealth.status === 200);
check('health check reports provider', resHealth.json?.status === 'ok' && resHealth.json?.provider === 'mock');

await gw3.close();

console.log('4) Content-Type & Invalid JSON Handling');
const gw4 = await startTestGateway();

const resNoHeader = await requestGateway({
    port: gw4.port,
    headers: { 'Content-Type': 'text/plain' },
    body: 'plain text prompt'
});
check('non-JSON content-type returns HTTP 400', resNoHeader.status === 400);
check('content-type error code is BAD_REQUEST', resNoHeader.json?.error?.code === ERROR_CODES.BAD_REQUEST);

const resBadJson = await requestGateway({
    port: gw4.port,
    headers: { 'Content-Type': 'application/json' },
    body: '{ prompt: missing quotes and invalid json'
});
check('malformed JSON returns HTTP 400', resBadJson.status === 400);
check('malformed JSON error message clear', /malformed json/i.test(resBadJson.json?.error?.message || ''));

await gw4.close();

console.log('5) Oversized Body Rejection (>32 KB limit)');
const gw5 = await startTestGateway({ maxBodySize: 1024 }); // 1 KB for test

const oversizedText = 'A'.repeat(2048);
const resOversized = await requestGateway({
    port: gw5.port,
    body: { prompt: oversizedText }
});
check('oversized payload returns HTTP 413', resOversized.status === 413);
check('payload error code is PAYLOAD_TOO_LARGE', resOversized.json?.error?.code === ERROR_CODES.PAYLOAD_TOO_LARGE);

await gw5.close();

console.log('6) Missing Required Fields');
const gw6 = await startTestGateway();

const resNoPrompt = await requestGateway({
    port: gw6.port,
    body: {}
});
check('missing prompt returns HTTP 400', resNoPrompt.status === 400);
check('missing prompt error message identified', /prompt/i.test(resNoPrompt.json?.error?.message || ''));

const resEmptyPrompt = await requestGateway({
    port: gw6.port,
    body: { prompt: '   ' }
});
check('whitespace prompt returns HTTP 400', resEmptyPrompt.status === 400);

await gw6.close();

console.log('7) SSRF Protection & Parameter Whitelisting');
const gw7 = await startTestGateway();

// Injection attempts
const resUrlInj = await requestGateway({
    port: gw7.port,
    body: { prompt: 'test', url: 'http://169.254.169.254/latest/meta-data/' }
});
check('arbitrary upstream URL injection rejected with HTTP 400', resUrlInj.status === 400);
check('URL injection error message specifies prohibited field', /prohibited/i.test(resUrlInj.json?.error?.message || ''));

const resDestInj = await requestGateway({
    port: gw7.port,
    body: { prompt: 'test', destination: 'https://evil.internal.network' }
});
check('arbitrary destination injection rejected with HTTP 400', resDestInj.status === 400);

const resAuthInj = await requestGateway({
    port: gw7.port,
    body: { prompt: 'test', apiKey: 'stolen_key' }
});
check('client apiKey injection rejected with HTTP 400', resAuthInj.status === 400);

await gw7.close();

console.log('8) Rate Limiting (In-Memory Sliding Window)');
const gw8 = await startTestGateway({ rateLimitPerMinute: 3 });

const r1 = await requestGateway({ port: gw8.port, body: { prompt: 'p1' } });
const r2 = await requestGateway({ port: gw8.port, body: { prompt: 'p2' } });
const r3 = await requestGateway({ port: gw8.port, body: { prompt: 'p3' } });
const r4 = await requestGateway({ port: gw8.port, body: { prompt: 'p4' } });

check('1st request allowed', r1.status === 200);
check('2nd request allowed', r2.status === 200);
check('3rd request allowed', r3.status === 200);
check('4th request blocked by rate limiter with HTTP 429', r4.status === 429);
check('rate limit error code is RATE_LIMITED', r4.json?.error?.code === ERROR_CODES.RATE_LIMITED);
check('retry-after header present', !!r4.headers['retry-after']);

await gw8.close();

console.log('9) Origin & CORS Handling');
const gw9 = await startTestGateway({
    allowedOrigins: ['http://localhost:3000']
});

const resAllowedOrigin = await requestGateway({
    port: gw9.port,
    headers: { Origin: 'http://localhost:3000' },
    body: { prompt: 'test' }
});
check('allowed origin returns HTTP 200', resAllowedOrigin.status === 200);
check('CORS header matches origin', resAllowedOrigin.headers['access-control-allow-origin'] === 'http://localhost:3000');

const resDisallowedOrigin = await requestGateway({
    port: gw9.port,
    headers: { Origin: 'http://malicious-website.com' },
    body: { prompt: 'test' }
});
check('disallowed origin rejected with HTTP 403', resDisallowedOrigin.status === 403);
check('wildcard CORS is never used', resDisallowedOrigin.headers['access-control-allow-origin'] !== '*');

await gw9.close();

console.log('10) Local Trust Token Mechanism');
const gw10 = await startTestGateway({
    localTrustToken: 'alice-secret-token-123'
});

const resNoToken = await requestGateway({
    port: gw10.port,
    body: { prompt: 'test' }
});
check('missing local trust token rejected with HTTP 401', resNoToken.status === 401);

const resValidToken = await requestGateway({
    port: gw10.port,
    headers: { 'X-Local-Trust-Token': 'alice-secret-token-123' },
    body: { prompt: 'test' }
});
check('valid local trust token accepted with HTTP 200', resValidToken.status === 200);

await gw10.close();

console.log('11) Upstream Provider Mock Error & Timeout Handling');

// Simulated provider timeout
const gwTimeout = await startTestGateway({
    provider: 'ollama', // use upstream dispatcher logic
    ollamaHost: 'http://127.0.0.1:54321', // non-listening port to test connection error
    upstreamTimeoutMs: 100
});

const resConnErr = await requestGateway({
    port: gwTimeout.port,
    body: { prompt: 'test' }
});
check('unreachable upstream returns HTTP 502', resConnErr.status === 502);
check('error code is PROVIDER_UNAVAILABLE', resConnErr.json?.error?.code === ERROR_CODES.PROVIDER_UNAVAILABLE);
check('no server paths or credentials leaked in error message', !resConnErr.json?.error?.message?.includes('/home/'));

await gwTimeout.close();

// Missing API Key for configured Groq provider
const gwMissingKey = await startTestGateway({
    provider: 'groq',
    groqApiKey: null
});

const resNoKey = await requestGateway({
    port: gwMissingKey.port,
    body: { prompt: 'test' }
});
check('missing provider API key returns HTTP 503', resNoKey.status === 503);
check('missing key error code is PROVIDER_UNAVAILABLE', resNoKey.json?.error?.code === ERROR_CODES.PROVIDER_UNAVAILABLE);
check('safe error message returned', /not configured on the server/i.test(resNoKey.json?.error?.message || ''));

await gwMissingKey.close();

// Custom upstream test handler (Simulated 500 error from upstream)
const gwCustomMock = await startTestGateway({
    provider: 'mock',
    mockHandler: () => {
        const err = new Error('Simulated upstream failure');
        err.statusCode = 502;
        err.code = ERROR_CODES.PROVIDER_UNAVAILABLE;
        err.clientMessage = 'Upstream AI provider error (HTTP 500)';
        throw err;
    }
});

const resUpstreamErr = await requestGateway({
    port: gwCustomMock.port,
    body: { prompt: 'test' }
});
check('upstream failure returns normalized HTTP 502', resUpstreamErr.status === 502);
check('normalized error envelope format', !!resUpstreamErr.json?.error && resUpstreamErr.json.error.code === ERROR_CODES.PROVIDER_UNAVAILABLE);

await gwCustomMock.close();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
