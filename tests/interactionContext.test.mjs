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

// --- Part 7B: explicit intent context plumbing (focused, per-value) ---------
//
// The intent field must be able to safely receive an explicitly supplied
// value in the future. These focused tests pin that contract per value:
// valid explicit intents are preserved verbatim, missing/invalid ones fall
// back to the documented 'unknown' default, and request text NEVER infers
// or overrides intent. No intent detection exists in this module.

test('Part 7B: explicit valid intent "information" is preserved', () => {
    const ctx = createInteractionContext({ intent: 'information' });
    assert.equal(ctx.intent, 'information');
    // Supplying an intent selects or alters nothing else.
    assert.deepEqual(ctx, { ...EXPECTED_DEFAULTS, intent: 'information' });
    assert.deepEqual(Object.keys(ctx), EXPECTED_KEYS);
    assert.ok(Object.isFrozen(ctx));
});

test('Part 7B: explicit valid intent "action" is preserved', () => {
    const ctx = createInteractionContext({ intent: 'action' });
    assert.equal(ctx.intent, 'action');
    assert.deepEqual(ctx, { ...EXPECTED_DEFAULTS, intent: 'action' });
});

test('Part 7B: explicit valid intent "conversation" is preserved', () => {
    const ctx = createInteractionContext({ intent: 'conversation' });
    assert.equal(ctx.intent, 'conversation');
    assert.deepEqual(ctx, { ...EXPECTED_DEFAULTS, intent: 'conversation' });
});

test('Part 7B: explicit valid intent "clarification" is preserved', () => {
    const ctx = createInteractionContext({ intent: 'clarification' });
    assert.equal(ctx.intent, 'clarification');
    assert.deepEqual(ctx, { ...EXPECTED_DEFAULTS, intent: 'clarification' });
});

test('Part 7B: missing intent becomes "unknown"', () => {
    // Absent key, explicit undefined, and null all mean "no intent supplied".
    assert.equal(createInteractionContext({}).intent, 'unknown');
    assert.equal(createInteractionContext({ intent: undefined }).intent, 'unknown');
    assert.equal(createInteractionContext({ intent: null }).intent, 'unknown');
    // Supplying other fields never implies an intent.
    assert.equal(createInteractionContext({
        request: 'hello',
        turnType: 'follow_up',
        source: 'voice'
    }).intent, 'unknown');
});

test('Part 7B: invalid intent becomes "unknown"', () => {
    // Wrong casing, near-misses, and wrong types all normalize to 'unknown'.
    for (const invalid of ['Information', 'INFORMATION', 'question', 'answer', 'command',
        'greeting', 'smalltalk', '', 0, 42, true, {}, [], ['information']]) {
        assert.equal(createInteractionContext({ intent: invalid }).intent, 'unknown',
            `invalid intent ${JSON.stringify(invalid)}`);
    }
});

test('Part 7B: request text never infers or overrides intent', () => {
    // Wording that looks like any of the allowed intents must not set intent.
    const requests = [
        'What is quantum computing?',                        // looks informational
        'Open the notes app and add milk to the list.',      // looks actionable
        'Hi there! How are you doing today?',                // looks conversational
        'Sorry, could you clarify what you meant?'           // looks like clarification
    ];
    for (const request of requests) {
        const ctx = createInteractionContext({ request });
        assert.equal(ctx.intent, 'unknown', `request must not infer intent: ${request}`);
        // The context equals the pure defaults plus the request — nothing else.
        assert.deepEqual(ctx, { ...EXPECTED_DEFAULTS, request });
    }

    // An explicit intent always wins over the request wording.
    const explicit = createInteractionContext({
        request: 'What is quantum computing?',
        intent: 'action'
    });
    assert.equal(explicit.intent, 'action');
    assert.equal(explicit.request, 'What is quantum computing?');
    assert.deepEqual(explicit, {
        ...EXPECTED_DEFAULTS,
        request: 'What is quantum computing?',
        intent: 'action'
    });
});

test('Part 7B: intent is assigned only from the explicit input field, never the request', async () => {
    const source = await readFile(new URL('../js/ai/interactionContext.js', import.meta.url), 'utf8');
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    // The single intent assignment normalizes ONLY the explicit caller
    // input against the frozen enum with the documented default.
    assert.match(code,
        /intent:\s*normalizeEnum\(input\.intent,\s*INTERACTION_INTENTS,\s*INTERACTION_CONTEXT_DEFAULTS\.intent\)/);
    // No code line mixes the request field with the intent field, so intent
    // can never be derived from request text inside this module.
    assert.doesNotMatch(code, /request[^;\n]*intent|intent[^;\n]*request/i);
    // No intent-detection/inference helper is referenced anywhere.
    assert.doesNotMatch(code, /\binferIntent\b|\bdetectIntent\b|\bclassifyIntent\b|INTENT_KEYWORDS/i);
});

test('Part 7B: explicit intent leaves Part 7A turnType behavior unchanged', () => {
    // turnType is still caller-supplied and still normalized independently
    // of the intent field.
    assert.equal(createInteractionContext({ turnType: 'follow_up', intent: 'information' }).turnType, 'follow_up');
    assert.equal(createInteractionContext({ turnType: 'new', intent: 'action' }).turnType, 'new');
    assert.equal(createInteractionContext({ turnType: 'continuation', intent: 'information' }).turnType, 'new');
    assert.equal(createInteractionContext({ intent: 'information' }).turnType, 'new');
});

test('Part 7B: explicit intent leaves source behavior unchanged', () => {
    assert.equal(createInteractionContext({ source: 'voice', intent: 'conversation' }).source, 'voice');
    assert.equal(createInteractionContext({ source: 'text', intent: 'action' }).source, 'text');
    assert.equal(createInteractionContext({ source: 'email', intent: 'conversation' }).source, 'text');
    assert.equal(createInteractionContext({ intent: 'conversation' }).source, 'text');
});

test('Part 7B: explicit intent leaves responseDepth, mode, and emotionalSignal behavior unchanged', () => {
    const explicit = createInteractionContext({
        intent: 'clarification',
        responseDepth: 'deep',
        mode: 'guardian',
        emotionalSignal: 'confused'
    });
    assert.equal(explicit.responseDepth, 'deep');
    assert.equal(explicit.mode, 'guardian');
    assert.equal(explicit.emotionalSignal, 'confused');

    // Invalid values still fall back to their documented defaults.
    const invalid = createInteractionContext({
        intent: 'clarification',
        responseDepth: 'huge',
        mode: 'wizard',
        emotionalSignal: 'furious'
    });
    assert.equal(invalid.responseDepth, 'quick');
    assert.equal(invalid.mode, null);
    assert.equal(invalid.emotionalSignal, 'neutral');
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
        // Part 7B: receiving an explicit intent requires no network either,
        // and request text alone still yields no inferred intent.
        for (const intent of INTERACTION_INTENTS) {
            assert.equal(createInteractionContext({ intent }).intent, intent);
        }
        assert.equal(createInteractionContext({ request: 'What is quantum computing?' }).intent, 'unknown');
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
