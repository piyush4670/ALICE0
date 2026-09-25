// Part 9A — validation only. Run offline with:
//   node --test tests/part9a-runtime-personality-validation.test.mjs
// Opt in to the already-running local gateway (no skill/agent execution):
//   ALICE_LIVE_AI_TEST=1 node --test tests/part9a-runtime-personality-validation.test.mjs
// Observes the real ConversationManager → detectors → AIBrain → ContextBuilder
// → adapter path. Only the last hop is replaced by a recorder in offline mode.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Browser-only globals needed by the production singleton imports.
globalThis.localStorage = {
    _d: {}, getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; } },
    open() {}, SpeechRecognition: undefined, webkitSpeechRecognition: undefined,
    AudioContext: undefined, webkitAudioContext: undefined
};
globalThis.speechSynthesis = window.speechSynthesis;
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: undefined, permissions: undefined }, configurable: true
});
globalThis.document = {
    createElement() {
        return { style: {}, setAttribute() {}, click() {},
            classList: { add() {}, remove() {} }, appendChild() {},
            querySelector() { return null; }, getContext() { return null; } };
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; }, querySelector() { return null; },
    querySelectorAll() { return []; }, addEventListener() {}
};
globalThis.Blob = class { constructor() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
    const handle = nativeSetInterval(...args);
    handle?.unref?.();
    return handle;
};

// Closed by default even when live mode is requested: only the live test
// temporarily opens this gate. Unexpected fetches fail, not silently pass.
const nativeFetch = globalThis.fetch;
let networkOpen = false;
let fetchCount = 0;
const liveStatuses = [];
globalThis.fetch = async (...args) => {
    fetchCount++;
    if (!networkOpen || typeof nativeFetch !== 'function') {
        throw new Error('Part 9A: unexpected network call from offline validation');
    }
    const response = await nativeFetch(...args);
    liveStatuses.push(response.status);
    return response;
};

const { conversation } = await import('../js/conversation.js');
const { aiBrain } = await import('../js/ai/aiBrain.js');
const { contextBuilder } = await import('../js/ai/contextBuilder.js');
const { ModelAdapter } = await import('../js/ai/modelAdapter.js');
const { HttpModelAdapter, resolveGatewayUrl } = await import('../js/ai/httpModelAdapter.js');
const { createInteractionContext } = await import('../js/ai/interactionContext.js');
const { getEmotionalResponseGuidance } = await import('../js/ai/emotionalResponseGuidance.js');
const { detectIntent } = await import('../js/ai/intentDetector.js');
const { detectResponseDepth } = await import('../js/ai/responseDepthDetector.js');
const { detectPersonalityMode } = await import('../js/ai/personalityModeDetector.js');
const { detectEmotionalSignal } = await import('../js/ai/emotionalSignalDetector.js');
const { CONFIG } = await import('../js/config.js');
globalThis.setInterval = nativeSetInterval;

const cases = [
    ["I'm frustrated. What is photosynthesis?", { intent: 'information', emotionalSignal: 'frustrated', responseDepth: 'quick', mode: null, source: 'text' }],
    ["I'm sad. Calculate 25% of 800.", { intent: 'action', emotionalSignal: 'sad', responseDepth: 'quick', mode: null, source: 'text' }],
    ["I'm confused. Explain quantum computing in simple words.", { intent: 'information', emotionalSignal: 'confused', responseDepth: 'quick', mode: null, source: 'text' }],
    ["I'm bored. Tell me one interesting fact.", { intent: 'information', emotionalSignal: 'bored', responseDepth: 'quick', mode: null, source: 'text' }],
    ['Explain photosynthesis in detail.', { intent: 'information', responseDepth: 'deep' }],
    ['Just the answer: what is 2 + 2?', { intent: 'information', responseDepth: 'quick' }],
    ['Be playful and tell me a fun fact.', { mode: 'playful', intent: 'information' }],
    // "Be patient" is not an explicit cue in the existing mode detector.
    ['Be patient and explain this gently.', { mode: null }]
];

class Recorder extends ModelAdapter {
    calls = [];
    async generate(prompt, options) {
        this.calls.push({ prompt, options });
        return { text: '', structured: { response: 'Captured without executing any skills.' } };
    }
}

// Call-through spies observe actual input AND output without replacing any
// detector, brain, or builder behavior. All are restored, including on failure.
function observe(target, method, calls) {
    const original = target[method];
    const owned = Object.hasOwn(target, method);
    target[method] = function (...args) {
        const value = original.apply(this, args);
        calls.push({ args, value });
        return value;
    };
    return () => { if (owned) target[method] = original; else delete target[method]; };
}

async function capture(request) {
    const originalAdapter = aiBrain.getAdapter();
    const recorder = new Recorder();
    const brain = [], built = [], formatted = [];
    const restore = [
        observe(aiBrain, 'processRequest', brain),
        observe(contextBuilder, 'buildContext', built),
        observe(contextBuilder, 'formatForPrompt', formatted)
    ];
    conversation.clearHistory(); // each scenario is a fresh text turn
    const before = fetchCount;
    try {
        aiBrain.setAdapter(recorder);
        const result = await conversation._processWithSkills(request, null, 'text');
        assert.equal(fetchCount, before, 'offline stage: unexpected network call');
        assert.deepEqual(result, { response: 'Captured without executing any skills.', skill: 'ai' },
            'conversation stage: request bypassed AI or entered fallback/skill execution');
        assert.equal(brain.length, 1, 'conversation stage: expected one AI Brain request');
        assert.equal(built.length, 1, 'context builder stage: expected one buildContext call');
        assert.equal(formatted.length, 1, 'context builder stage: expected one formatForPrompt call');
        assert.equal(recorder.calls.length, 1, 'adapter stage: expected one generate call');
        return { brain: brain[0], built: built[0], formatted: formatted[0], adapter: recorder.calls[0] };
    } finally {
        aiBrain.setAdapter(originalAdapter);
        for (const undo of restore.reverse()) undo();
    }
}

function section(prompt, heading) {
    const blocks = prompt.split('\n\n').filter(b => b.startsWith(heading));
    assert.equal(blocks.length, 1, `prompt stage: missing or duplicate ${heading}`);
    return blocks[0];
}

function assertPipeline(request, captureResult) {
    const { brain, built, formatted, adapter } = captureResult;
    const metadata = brain.args[1]?.interactionContext;
    assert.equal(brain.args[0], request, 'conversation stage: original request not forwarded');
    assert.ok(metadata && Object.isFrozen(metadata), 'conversation stage: no normalized InteractionContext');
    assert.deepEqual(Object.keys(metadata).sort(),
        ['emotionalSignal', 'intent', 'mode', 'request', 'responseDepth', 'source', 'turnType'],
        'conversation stage: InteractionContext shape mismatch');
    assert.equal(metadata.request, '', 'conversation stage: unexpected embedded request');
    assert.equal(metadata.turnType, 'new', 'conversation stage: fresh turn type mismatch');
    const detected = createInteractionContext({
        turnType: 'new', intent: detectIntent(request).intent,
        responseDepth: detectResponseDepth(request).depth,
        mode: detectPersonalityMode(request).mode,
        emotionalSignal: detectEmotionalSignal(request).signal, source: 'text'
    });
    assert.deepEqual(metadata, detected, 'detector stage: ConversationManager metadata differs from production detectors');

    assert.equal(built.args[0].request, request, 'context builder stage: request missing from build input');
    assert.strictEqual(built.args[0].interactionContext, metadata,
        'context builder stage: did not receive the ConversationManager metadata');
    assert.deepEqual(built.value.interactionContext, metadata,
        'context builder stage: normalized metadata changed');
    assert.strictEqual(formatted.args[0], built.value,
        'context builder stage: formatted a different context object');
    assert.equal(built.value.request, request, 'context builder stage: original request lost');
    const prompt = formatted.value;
    assert.equal(adapter.prompt, prompt, 'AI Brain stage: generated prompt not passed unchanged to adapter');
    assert.equal(typeof prompt, 'string', 'context builder stage: prompt is not text');
    assert.equal(Object.hasOwn(adapter.options, 'interactionContext'), false,
        'adapter options contaminated with interactionContext');
    assert.equal(adapter.options.responseFormat, 'plan', 'adapter stage: JSON/plan output not requested');

    const headings = ['System:', 'ALICE Identity:', 'Interaction Context:',
        'Emotional Response Guidance:', 'Response Priority Contract:',
        'Required JSON Output Contract', 'User Request:'];
    let previous = -1;
    for (const heading of headings) {
        const block = section(prompt, heading);
        const position = prompt.indexOf(block);
        assert.ok(position > previous, `prompt stage: ${heading} missing or out of order`);
        previous = position;
    }
    assert.match(section(prompt, 'ALICE Identity:'), /- Name: ALICE\b/,
        'prompt stage: missing ALICE identity');
    const interaction = section(prompt, 'Interaction Context:');
    for (const [label, value] of Object.entries({
        'Turn type': metadata.turnType, Intent: metadata.intent,
        'Response depth': metadata.responseDepth, 'Personality mode': metadata.mode ?? 'none',
        'Broad contextual signal': metadata.emotionalSignal, Source: metadata.source
    })) {
        assert.ok(interaction.split('\n').includes(`- ${label}: ${value}`),
            `prompt stage: interaction metadata missing: ${label} = ${value}`);
    }
    assert.match(interaction, /user's expressed signal, not an emotion experienced by ALICE/i,
        'prompt stage: forbidden emotional framing / missing user-only framing');
    const guidance = getEmotionalResponseGuidance(metadata.emotionalSignal);
    const guidanceBlock = section(prompt, 'Emotional Response Guidance:');
    assert.ok(guidanceBlock.includes(`- Expressed signal: ${guidance.signal}`),
        'prompt stage: missing emotional guidance signal');
    assert.ok(guidanceBlock.includes(`- Communication tone: ${guidance.tone}`),
        'prompt stage: missing emotional guidance tone');
    for (const rule of guidance.guidance) {
        assert.ok(guidanceBlock.includes(`  - ${rule}`), 'prompt stage: missing emotional guidance rule');
    }
    assert.ok(guidanceBlock.includes(`- Scope: ${guidance.scope}`),
        'prompt stage: missing bounded guidance scope');
    for (const boundary of guidance.safety) {
        assert.ok(guidanceBlock.includes(`  - ${boundary}`),
            `prompt stage: missing emotional safety boundary: ${boundary}`);
    }
    const priority = section(prompt, 'Response Priority Contract:');
    for (const rule of [
        "The user's request is the primary task and must be answered or handled first.",
        "Emotional guidance must never replace, reinterpret, or override the user's actual request.",
        'Never let emotional guidance override safety, permissions, validation, confirmation, or user autonomy.',
        'Never claim ALICE experiences human emotions.'
    ]) {
        assert.ok(priority.includes(rule), `prompt stage: missing priority contract: ${rule}`);
    }
    assert.match(section(prompt, 'Required JSON Output Contract'), /\{"response": "your natural-language answer"\}/,
        'prompt stage: missing required JSON direct-response shape');
    assert.equal(prompt.split(request).length - 1, 1,
        'prompt stage: user request missing or duplicated');
    assert.equal(prompt.split('\n\n').at(-1), `User Request: "${request}"`,
        'prompt stage: emotional guidance replaced the user request');
    assert.ok(prompt.length <= CONFIG.ai.gateway.maxPromptChars,
        'adapter stage: prompt exceeds configured gateway limit');
}

function assertExpectedMetadata(request, expected, captureResult) {
    // Run after the structural checks, so even mismatched detector expectations
    // still verify the complete prompt path. Do not change the pinned values.
    const metadata = captureResult.brain.args[1].interactionContext;
    for (const [key, value] of Object.entries(expected)) {
        assert.equal(metadata[key], value, `detector metadata mismatch: ${key} for ${JSON.stringify(request)}`);
    }
}

test('Part 9A preconditions: configured runtime uses the production builder and HTTP adapter', () => {
    assert.equal(CONFIG.ai.enabled, true);
    assert.ok(aiBrain.isEnabled());
    assert.strictEqual(aiBrain.getContextBuilder(), contextBuilder);
    assert.ok(aiBrain.getAdapter() instanceof HttpModelAdapter);
});

for (const [index, [request, expected]] of cases.entries()) {
    test(`Part 9A case ${index + 1}: ${request}`, async () => {
        const observed = await capture(request);
        assertPipeline(request, observed);
        assertExpectedMetadata(request, expected, observed);
    });
}

test('Part 9A offline gate and restoration', () => {
    assert.equal(fetchCount, 0, 'offline stage: external fetch was attempted');
    assert.ok(aiBrain.getAdapter() instanceof HttpModelAdapter, 'configured adapter not restored');
    assert.equal(Object.hasOwn(aiBrain, 'processRequest'), false, 'AI Brain spy not restored');
    assert.equal(Object.hasOwn(contextBuilder, 'buildContext'), false, 'ContextBuilder spy not restored');
    assert.equal(Object.hasOwn(contextBuilder, 'formatForPrompt'), false, 'formatter spy not restored');
});

// Only enabled by exact opt-in. Probe the SAME local gateway as the adapter;
// skip if absent, but fail if a reachable gateway rejects requests. Live calls
// use the brain rather than conversation to avoid executing any model plan.
test('Part 9A optional live gateway/adapter structural check', {
    skip: process.env.ALICE_LIVE_AI_TEST === '1' ? false : 'set ALICE_LIVE_AI_TEST=1 to opt in',
    timeout: 120_000
}, async (t) => {
    const adapter = aiBrain.getAdapter();
    assert.ok(adapter instanceof HttpModelAdapter);
    const endpoint = new URL(resolveGatewayUrl());
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname),
        'live stage: only a local gateway may be contacted');
    networkOpen = true;
    try {
        let health;
        try {
            health = await fetch(new URL('/api/health', endpoint), { signal: AbortSignal.timeout(2000) });
        } catch (error) {
            if (error?.cause?.code === 'ECONNREFUSED' || error?.name === 'TimeoutError') {
                t.diagnostic('Local gateway unavailable; live check skipped.');
                t.skip('local gateway not running');
                return;
            }
            throw error;
        }
        assert.equal(health.status, 200, 'live stage: gateway health failed');
        for (const [request] of cases) {
            const captured = await capture(request);
            assertPipeline(request, captured);
            const outbound = [];
            const statusesBefore = liveStatuses.length;
            const undo = observe(adapter, 'generate', outbound);
            let result;
            try {
                result = await aiBrain.processRequest(request, {
                    interactionContext: captured.brain.args[1].interactionContext
                });
            } finally {
                undo();
            }
            assert.equal(outbound.length, 1, `live stage: missing adapter call for ${JSON.stringify(request)}`);
            assert.equal(outbound[0].args[0], captured.adapter.prompt,
                `live stage: sent prompt differs for ${JSON.stringify(request)}`);
            assert.equal(Object.hasOwn(outbound[0].args[1], 'interactionContext'), false,
                'live stage: adapter options contaminated with interactionContext');
            assert.equal(liveStatuses.length, statusesBefore + 1,
                `live stage: expected one gateway request for ${JSON.stringify(request)}`);
            assert.equal(liveStatuses.at(-1), 200,
                `live stage: gateway generation HTTP failure for ${JSON.stringify(request)}`);
            assert.ok(result && typeof result.success === 'boolean',
                `live stage: invalid AI Brain result for ${JSON.stringify(request)}`);
            // Model content is untrusted: a rejected plan/JSON is a valid
            // runtime outcome, not a personality assertion or skill execution.
            if (result.success && result.isMultiStep) {
                assert.ok(Array.isArray(result.plan) && result.plan.length > 0,
                    'live stage: accepted plan missing steps');
            } else if (result.success) {
                assert.ok(typeof result.response === 'string' && result.response.trim(),
                    'live stage: accepted direct response missing text');
            } else {
                assert.equal(result.fallback, true, 'live stage: rejected output must fall back safely');
            }
        }
    } finally {
        networkOpen = false;
    }
});
