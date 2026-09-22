// Part 2 interaction context contract. Run: node --test tests/interactionContext.test.mjs
// Uses only Node built-ins and the interaction context module; no network or browser mocks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as module from '../js/ai/interactionContext.js';

const {
    INTERACTION_TURN_TYPES,
    INTERACTION_INTENTS,
    INTERACTION_RESPONSE_DEPTHS,
    INTERACTION_MODES,
    INTERACTION_EMOTIONAL_SIGNALS,
    INTERACTION_SOURCES,
    INTERACTION_CONTEXT_DEFAULTS,
    createInteractionContext
} = module;

const EXPECTED_KEYS = Object.freeze([
    'request', 'turnType', 'intent', 'responseDepth', 'mode', 'emotionalSignal', 'source'
]);

const EXPECTED_DEFAULTS = Object.freeze({
    request: '',
    turnType: 'new',
    intent: 'unknown',
    responseDepth: 'quick',
    mode: null,
    emotionalSignal: 'neutral',
    source: 'text'
});

function expectAllAccepted(field, allowedValues) {
    for (const value of allowedValues) {
        assert.equal(createInteractionContext({ [field]: value })[field], value, `${field}: ${value}`);
    }
}

test('creates a default context with exactly the documented keys and safe values', () => {
    const ctx = createInteractionContext();
    assert.deepEqual(ctx, EXPECTED_DEFAULTS);
    assert.deepEqual(Object.keys(ctx), EXPECTED_KEYS);
    // Missing or non-object input still yields the same safe defaults.
    assert.deepEqual(createInteractionContext(undefined), EXPECTED_DEFAULTS);
    assert.deepEqual(createInteractionContext(null), EXPECTED_DEFAULTS);
    assert.deepEqual(createInteractionContext('not-an-object'), EXPECTED_DEFAULTS);
});

test('trims and coerces the request safely', () => {
    assert.equal(createInteractionContext({ request: '  Explain quantum computing  ' }).request,
        'Explain quantum computing');
    assert.equal(createInteractionContext({ request: '   ' }).request, '');
    assert.equal(createInteractionContext({ request: 42 }).request, '42');
    assert.equal(createInteractionContext({ request: true }).request, 'true');
    assert.equal(createInteractionContext({ request: undefined }).request, '');
    assert.equal(createInteractionContext({ request: null }).request, '');
    // Arbitrary objects and arrays are never stringified into the request.
    assert.equal(createInteractionContext({ request: { toString: () => 'x' } }).request, '');
    assert.equal(createInteractionContext({ request: ['a'] }).request, '');
    assert.equal(createInteractionContext({ request: Symbol('s') }).request, '');
});

test('accepts valid turn types unchanged', () => {
    assert.deepEqual(INTERACTION_TURN_TYPES, ['new', 'follow_up']);
    expectAllAccepted('turnType', INTERACTION_TURN_TYPES);
});

test('normalizes invalid turn types to the safe default', () => {
    for (const invalid of ['NEW', 'New', 'followup', 'continuation', '', 1, null, undefined, {}, []]) {
        assert.equal(createInteractionContext({ turnType: invalid }).turnType, 'new',
            `invalid turnType ${JSON.stringify(invalid)}`);
    }
});

test('accepts valid intent values unchanged', () => {
    assert.deepEqual(INTERACTION_INTENTS, ['information', 'action', 'conversation', 'clarification', 'unknown']);
    expectAllAccepted('intent', INTERACTION_INTENTS);
});

test('normalizes invalid intent values to the safe default', () => {
    for (const invalid of ['Information', 'INFORMATION', 'answer', 'greeting', 'intent', '', 0, null, undefined, {}, []]) {
        assert.equal(createInteractionContext({ intent: invalid }).intent, 'unknown',
            `invalid intent ${JSON.stringify(invalid)}`);
    }
});

test('accepts valid response-depth values unchanged', () => {
    assert.deepEqual(INTERACTION_RESPONSE_DEPTHS, ['quick', 'explain', 'deep']);
    expectAllAccepted('responseDepth', INTERACTION_RESPONSE_DEPTHS);
    // Invalid depths also fall back to the documented default.
    for (const invalid of ['QUICK', 'Detailed', '', 3, null, {}]) {
        assert.equal(createInteractionContext({ responseDepth: invalid }).responseDepth, 'quick',
            `invalid responseDepth ${JSON.stringify(invalid)}`);
    }
});

test('accepts valid personality modes unchanged and keeps null as the default', () => {
    assert.deepEqual(INTERACTION_MODES, ['soft', 'focus', 'playful', 'analyst', 'guardian', 'teacher']);
    expectAllAccepted('mode', INTERACTION_MODES);
    assert.equal(createInteractionContext({ mode: null }).mode, null);
    assert.equal(createInteractionContext({ mode: undefined }).mode, null);
    // Invalid modes fall back to null (no mode selected), never to an arbitrary value.
    for (const invalid of ['SOFT', 'teacherly', 'robot', '', 7, {}, []]) {
        assert.equal(createInteractionContext({ mode: invalid }).mode, null,
            `invalid mode ${JSON.stringify(invalid)}`);
    }
});

test('accepts valid emotional/contextual signals unchanged', () => {
    assert.deepEqual(INTERACTION_EMOTIONAL_SIGNALS, [
        'neutral', 'happy', 'sad', 'angry', 'frustrated', 'confused',
        'nervous', 'excited', 'tired', 'lonely', 'curious', 'bored'
    ]);
    expectAllAccepted('emotionalSignal', INTERACTION_EMOTIONAL_SIGNALS);
    // Invalid signals fall back to 'neutral'; no detection happens here.
    for (const invalid of ['Happy', 'NEUTRAL', 'overjoyed', '', -1, null, {}]) {
        assert.equal(createInteractionContext({ emotionalSignal: invalid }).emotionalSignal, 'neutral',
            `invalid emotionalSignal ${JSON.stringify(invalid)}`);
    }
});

test('accepts valid source values unchanged', () => {
    assert.deepEqual(INTERACTION_SOURCES, ['text', 'voice']);
    expectAllAccepted('source', INTERACTION_SOURCES);
    // Invalid sources fall back to 'text'; no source detection happens here.
    for (const invalid of ['TEXT', 'Voice', 'email', '', 1, null, {}]) {
        assert.equal(createInteractionContext({ source: invalid }).source, 'text',
            `invalid source ${JSON.stringify(invalid)}`);
    }
});

test('defaults are deterministic across calls and inputs', () => {
    const first = createInteractionContext();
    const second = createInteractionContext(undefined);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));

    const invalidA = createInteractionContext({
        request: 'hello', turnType: 'x', intent: 'y', responseDepth: 'z',
        mode: 'zzz', emotionalSignal: '???', source: 'tv'
    });
    const invalidB = createInteractionContext({
        request: 'hello', turnType: 'x', intent: 'y', responseDepth: 'z',
        mode: 'zzz', emotionalSignal: '???', source: 'tv'
    });
    assert.deepEqual(invalidA, invalidB);
    assert.equal(JSON.stringify(invalidA), JSON.stringify(invalidB));

    // Unknown keys are dropped, so they cannot create arbitrary context state.
    const withExtra = createInteractionContext({ request: 'hi', extra: true, nested: { a: 1 } });
    assert.deepEqual(withExtra, createInteractionContext({ request: 'hi' }));
    assert.deepEqual(Object.keys(withExtra), EXPECTED_KEYS);
});

test('returned contexts are isolated from the shared constants', () => {
    const constants = [
        INTERACTION_TURN_TYPES,
        INTERACTION_INTENTS,
        INTERACTION_RESPONSE_DEPTHS,
        INTERACTION_MODES,
        INTERACTION_EMOTIONAL_SIGNALS,
        INTERACTION_SOURCES,
        INTERACTION_CONTEXT_DEFAULTS
    ];
    for (const constant of constants) {
        assert.ok(Object.isFrozen(constant), 'Every exported constant must be frozen');
    }

    const before = {
        turnTypes: [...INTERACTION_TURN_TYPES],
        intents: [...INTERACTION_INTENTS],
        depths: [...INTERACTION_RESPONSE_DEPTHS],
        modes: [...INTERACTION_MODES],
        signals: [...INTERACTION_EMOTIONAL_SIGNALS],
        sources: [...INTERACTION_SOURCES],
        defaults: { ...INTERACTION_CONTEXT_DEFAULTS }
    };

    const ctx = createInteractionContext({ request: 'hello' });
    // The returned context is a fresh frozen object, not the defaults object.
    assert.notEqual(ctx, INTERACTION_CONTEXT_DEFAULTS);
    assert.throws(() => { ctx.request = 'tampered'; }, TypeError);
    assert.throws(() => { ctx.turnType = 'action'; }, TypeError);
    assert.throws(() => { ctx.mode = 'guardian'; }, TypeError);
    assert.throws(() => { delete ctx.source; }, TypeError);

    // Mutating the shared constants directly is also impossible.
    assert.throws(() => { INTERACTION_TURN_TYPES.push('loop'); }, TypeError);
    assert.throws(() => { INTERACTION_CONTEXT_DEFAULTS.mode = 'focus'; }, TypeError);
    assert.throws(() => { INTERACTION_SOURCES[0] = 'email'; }, TypeError);

    assert.deepEqual({
        turnTypes: [...INTERACTION_TURN_TYPES],
        intents: [...INTERACTION_INTENTS],
        depths: [...INTERACTION_RESPONSE_DEPTHS],
        modes: [...INTERACTION_MODES],
        signals: [...INTERACTION_EMOTIONAL_SIGNALS],
        sources: [...INTERACTION_SOURCES],
        defaults: { ...INTERACTION_CONTEXT_DEFAULTS }
    }, before);
});

test('requires no network access', () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    globalThis.fetch = () => { throw new Error('network access attempted'); };
    globalThis.WebSocket = undefined;
    try {
        const ctx = createInteractionContext({ request: 'ping' });
        assert.equal(ctx.request, 'ping');
        assert.equal(ctx.source, 'text');
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.WebSocket = originalWebSocket;
    }
});

test('is dependency-free: no imports and no runtime I/O hooks in the module source', async () => {
    const source = await readFile(new URL('../js/ai/interactionContext.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s/m, 'module must not import anything');
    assert.doesNotMatch(source, /\brequire\s*\(/, 'module must not use require');
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bhttp\s*\.\s|https|net\.connect|dgram\.|child_process/,
        'module must not reference network or process I/O');
});
