// Tests for Phase 6.3.5 — local gateway runtime wiring.
// ------------------------------------------------------------------
// This phase is deployment wiring ONLY: index.html sets
// `window.ALICE_GATEWAY_URL` to the local gateway when ALICE0 itself is
// served from localhost/127.0.0.1, so HttpModelAdapter (unmodified) picks
// it up through its existing `window.ALICE_GATEWAY_URL` runtime hook.
//
// These tests do NOT re-test HttpModelAdapter's own validation logic
// (covered by tests/httpModelAdapter.test.mjs); they verify:
//   1. The inline bootstrap script in index.html resolves the expected
//      gateway URL for localhost / 127.0.0.1 and leaves other hosts alone.
//   2. resolveGatewayUrl() honours window.ALICE_GATEWAY_URL end-to-end for
//      both local hostnames.
//   3. No provider URL, provider name, or credential-shaped string is
//      present anywhere in the frontend source (index.html, js/**).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ FAILED: ${name}`); }
}

// ------------------------------------------------------------------
// Minimal browser globals required to import the ALICE modules
// ------------------------------------------------------------------
globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; } }
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: undefined, permissions: undefined }, configurable: true });
globalThis.document = {
    createElement() { return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return null; } }; },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};
globalThis.Blob = class { constructor() {} };
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};

const { resolveGatewayUrl } = await import('../js/ai/httpModelAdapter.js');

// ==================================================================
// 1) index.html bootstrap script resolves the expected hosts
// ==================================================================
console.log('1) index.html local-gateway bootstrap script');
{
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

    check('index.html references window.ALICE_GATEWAY_URL', html.includes('ALICE_GATEWAY_URL'));
    check('index.html points the local gateway at 127.0.0.1:3001', html.includes('http://127.0.0.1:3001'));
    check('index.html checks window.location.hostname', html.includes('window.location.hostname'));
    check('index.html handles the "localhost" hostname', /hostname\s*===\s*'localhost'/.test(html) || html.includes("host === 'localhost'"));
    check('index.html handles the "127.0.0.1" hostname', html.includes("'127.0.0.1'"));

    // Extract and execute the bootstrap IIFE in isolation against a fake
    // `window.location`, exactly like a real browser would run it.
    const scriptMatch = html.match(/<script>\s*\(function \(\) \{[\s\S]*?\}\)\(\);\s*<\/script>/);
    check('exactly one inline bootstrap script is present', !!scriptMatch);

    function runBootstrap(hostname) {
        const sandboxWindow = { location: { hostname } };
        const fn = new Function('window', scriptMatch[0].replace(/<\/?script>/g, ''));
        fn(sandboxWindow);
        return sandboxWindow.ALICE_GATEWAY_URL;
    }

    check('localhost resolves window.ALICE_GATEWAY_URL to the local gateway',
        runBootstrap('localhost') === 'http://127.0.0.1:3001');
    check('127.0.0.1 resolves window.ALICE_GATEWAY_URL to the local gateway',
        runBootstrap('127.0.0.1') === 'http://127.0.0.1:3001');
    check('a production hostname is left untouched',
        runBootstrap('alice.example.com') === undefined);
    check('an arbitrary/unrelated loopback-like hostname is left untouched',
        runBootstrap('127.0.0.1.evil.example.com') === undefined);
}

// ==================================================================
// 2) resolveGatewayUrl() honours the runtime hook end-to-end
// ==================================================================
console.log('2) resolveGatewayUrl() end-to-end with window.ALICE_GATEWAY_URL');
{
    const originalGlobal = globalThis.ALICE_GATEWAY_URL;
    try {
        globalThis.ALICE_GATEWAY_URL = 'http://127.0.0.1:3001';
        check('localhost deployment resolves to the local gateway generate endpoint',
            resolveGatewayUrl() === 'http://127.0.0.1:3001/api/ai/generate');

        delete globalThis.ALICE_GATEWAY_URL;
        globalThis.ALICE_GATEWAY_URL = 'http://127.0.0.1:3001';
        check('127.0.0.1 deployment resolves to the same local gateway endpoint',
            resolveGatewayUrl() === 'http://127.0.0.1:3001/api/ai/generate');
    } finally {
        if (originalGlobal === undefined) delete globalThis.ALICE_GATEWAY_URL;
        else globalThis.ALICE_GATEWAY_URL = originalGlobal;
    }

    // Non-local (production) deployments are never forced onto the local
    // gateway: with no runtime hook set, the client falls back to the
    // same-origin default path rather than any hardcoded local URL.
    delete globalThis.ALICE_GATEWAY_URL;
    check('without the runtime hook, resolution falls back to the same-origin default path',
        resolveGatewayUrl() === '/api/ai/generate');
}

// ==================================================================
// 3) No provider credentials or provider URLs anywhere in frontend source
// ==================================================================
console.log('3) frontend source contains no provider URLs or credentials');
{
    const FORBIDDEN_SUBSTRINGS = [
        'api.groq.com',
        'api.openai.com',
        'openrouter.ai',
        'generativelanguage.googleapis.com',
        'GROQ_API_KEY',
        'OPENAI_API_KEY',
        'OPENROUTER_API_KEY'
    ];

    function collectFiles(dir, out = []) {
        for (const entry of readdirSync(dir)) {
            if (entry === 'node_modules' || entry === '.git' || entry === 'tests' || entry === 'server' || entry === 'docs') continue;
            const full = join(dir, entry);
            const s = statSync(full);
            if (s.isDirectory()) collectFiles(full, out);
            else if (/\.(js|mjs|html|css)$/.test(entry)) out.push(full);
        }
        return out;
    }

    const frontendFiles = [
        join(ROOT, 'index.html'),
        ...collectFiles(join(ROOT, 'js'))
    ];

    let clean = true;
    for (const file of frontendFiles) {
        const content = readFileSync(file, 'utf8');
        for (const needle of FORBIDDEN_SUBSTRINGS) {
            if (content.includes(needle)) {
                clean = false;
                console.log(`    ! forbidden string "${needle}" found in ${file}`);
            }
        }
    }
    check('no provider hostnames or provider API key env names appear in frontend source', clean);

    // The only absolute gateway destination allowed anywhere in frontend
    // source is the local loopback gateway.
    const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const httpUrls = indexHtml.match(/https?:\/\/[^\s"'<>]+/g) || [];
    const nonLoopbackNonFonts = httpUrls.filter(u =>
        !u.startsWith('http://127.0.0.1:3001') &&
        !u.includes('fonts.googleapis.com') &&
        !u.includes('fonts.gstatic.com')
    );
    check('index.html contains no absolute URLs besides the local gateway and font preconnects',
        nonLoopbackNonFonts.length === 0);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
