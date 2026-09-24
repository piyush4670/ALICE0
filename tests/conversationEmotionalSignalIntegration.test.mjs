// Part 8A: ConversationManager emotional-signal integration.
// Detection metadata only — response text, tone, and other detectors stay put.
import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';

globalThis.localStorage = {
    _d: {}, getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: {
        cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; }
    },
    open() {}, SpeechRecognition: undefined, webkitSpeechRecognition: undefined,
    AudioContext: undefined, webkitAudioContext: undefined
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: undefined, permissions: undefined }, configurable: true
});
globalThis.document = {
    createElement() {
        return {
            style: {}, setAttribute() {}, click() {},
            classList: { add() {}, remove() {} },
            appendChild() {}, querySelector() { return null; }, getContext() { return null; }
        };
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

let fetchCalls = 0;
globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    throw new Error(`Unexpected network access: ${String(args[0])}`);
};

const { conversation } = await import('../js/conversation.js');
const { aiBrain } = await import('../js/ai/aiBrain.js');
const { detectEmotionalSignal } = await import('../js/ai/emotionalSignalDetector.js');
const { detectIntent } = await import('../js/ai/intentDetector.js');
const { detectResponseDepth } = await import('../js/ai/responseDepthDetector.js');
const { detectPersonalityMode } = await import('../js/ai/personalityModeDetector.js');
globalThis.setInterval = nativeSetInterval;

const CONTEXT_KEYS = [
    'emotionalSignal', 'intent', 'mode', 'request', 'responseDepth', 'source', 'turnType'
];

function stubBrain() {
    const original = aiBrain.processRequest;
    const calls = [];
    aiBrain.processRequest = async (text, options) => {
        calls.push({ text, options });
        return { success: true, isMultiStep: false, response: 'ok' };
    };
    return { calls, restore() { aiBrain.processRequest = original; } };
}

describe('ConversationManager Part 8A emotional-signal integration', { concurrency: 1 }, () => {
    beforeEach(() => {
        conversation.clearHistory();
        fetchCalls = 0;
    });

    afterEach(() => {
        assert.equal(fetchCalls, 0, 'Part 8A tests must not perform network access');
        assert.equal(aiBrain.isEnabled(), true);
    });

    test('explicit phrases set emotionalSignal; other InteractionContext fields stay on their detectors', async () => {
        const stub = stubBrain();
        const cases = [
            { text: 'I am confused', source: 'text', signal: 'confused', turnType: 'new' },
            { text: "I'm excited!", source: 'voice', signal: 'excited', turnType: 'new' },
            { text: 'I am tired', source: 'text', signal: 'tired', turnType: 'new' },
            { text: 'What is photosynthesis?', source: 'text', signal: 'neutral', turnType: 'new' }
        ];
        try {
            for (const item of cases) {
                conversation.clearHistory();
                const snapshot = item.text;
                const result = await conversation._processWithSkills(item.text, null, item.source);
                assert.equal(item.text, snapshot, 'caller input must not be mutated');
                assert.equal(result.response, 'ok', 'response text must not be rewritten from the signal');
                assert.equal(result.skill, 'ai');

                assert.equal(stub.calls.length, 1);
                const ctx = stub.calls[0].options.interactionContext;
                assert.equal(ctx.emotionalSignal, item.signal);
                assert.equal(ctx.emotionalSignal, detectEmotionalSignal(item.text).signal);
                assert.equal(ctx.turnType, item.turnType);
                assert.equal(ctx.intent, detectIntent(item.text).intent);
                assert.equal(ctx.responseDepth, detectResponseDepth(item.text).depth);
                assert.equal(ctx.mode, detectPersonalityMode(item.text).mode);
                assert.equal(ctx.source, item.source);
                assert.equal('confidence' in ctx, false, 'confidence must not be added to InteractionContext');
                assert.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
                assert.equal(Object.isFrozen(ctx), true);
                assert.deepEqual(Object.keys(stub.calls[0].options), ['interactionContext']);
                stub.calls.length = 0;
            }
        } finally { stub.restore(); }
    });

    test('concrete field values for the required phrases', async () => {
        const stub = stubBrain();
        try {
            await conversation._processWithSkills('I am confused', null, 'text');
            await conversation._processWithSkills("I'm excited!", null, 'voice');
            await conversation._processWithSkills('I am tired', null, 'text');
            conversation.clearHistory();
            await conversation._processWithSkills('What is photosynthesis?', null, 'text');

            const [confused, excited, tired, neutral] = stub.calls.map((call) => call.options.interactionContext);
            assert.equal(confused.emotionalSignal, 'confused');
            assert.equal(confused.turnType, 'new');
            assert.equal(confused.intent, 'unknown');
            assert.equal(confused.responseDepth, 'quick');
            assert.equal(confused.mode, null);
            assert.equal(confused.source, 'text');

            assert.equal(excited.emotionalSignal, 'excited');
            assert.equal(excited.turnType, 'follow_up');
            assert.equal(excited.intent, 'unknown');
            assert.equal(excited.responseDepth, 'quick');
            assert.equal(excited.mode, null);
            assert.equal(excited.source, 'voice');

            assert.equal(tired.emotionalSignal, 'tired');
            assert.equal(tired.turnType, 'follow_up');
            assert.equal(tired.intent, 'unknown');
            assert.equal(tired.responseDepth, 'quick');
            assert.equal(tired.mode, null);
            assert.equal(tired.source, 'text');

            assert.equal(neutral.emotionalSignal, 'neutral');
            assert.equal(neutral.turnType, 'new');
            assert.equal(neutral.intent, 'information');
            assert.equal(neutral.responseDepth, 'quick');
            assert.equal(neutral.mode, null);
            assert.equal(neutral.source, 'text');
        } finally { stub.restore(); }
    });

    test('emotional metadata does not override intent, depth, mode, source, or turn lifecycle', async () => {
        const stub = stubBrain();
        try {
            const first = "I don't understand";
            const second = 'Teach me, I am tired';
            await conversation._processWithSkills(first, null, 'text');
            await conversation._processWithSkills(second, null, 'voice');

            const [a, b] = stub.calls.map((call) => call.options.interactionContext);
            assert.equal(a.emotionalSignal, 'confused');
            assert.equal(a.intent, 'clarification');
            assert.equal(a.responseDepth, 'quick');
            assert.equal(a.mode, null);
            assert.equal(a.source, 'text');
            assert.equal(a.turnType, 'new');

            assert.equal(b.emotionalSignal, 'tired');
            assert.equal(b.intent, detectIntent(second).intent);
            assert.equal(b.responseDepth, detectResponseDepth(second).depth);
            assert.equal(b.mode, 'teacher');
            assert.equal(b.source, 'voice');
            assert.equal(b.turnType, 'follow_up');
        } finally { stub.restore(); }
    });

    test('non-string caller input is not mutated and does not throw', async () => {
        const stub = stubBrain();
        const input = { raw: 'I am tired', extra: 1 };
        const before = { ...input };
        try {
            const result = await conversation._processWithSkills(input, null, 'text');
            assert.deepEqual(input, before);
            assert.equal(result.response, 'ok');
            assert.equal(stub.calls[0].options.interactionContext.emotionalSignal, 'neutral');
            assert.equal(stub.calls[0].text, input);
        } finally { stub.restore(); }
    });

    test('wiring passes only detectEmotionalSignal(text).signal', async () => {
        const { readFile } = await import('node:fs/promises');
        const source = await readFile(new URL('../js/conversation.js', import.meta.url), 'utf8');
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.match(source, /import\s*\{\s*detectEmotionalSignal\s*\}\s*from\s*['"]\.\/ai\/emotionalSignalDetector\.js['"]/);
        assert.equal(code.match(/detectEmotionalSignal\s*\(/g).length, 1);
        assert.match(code, /emotionalSignal:\s*detectEmotionalSignal\(text\)\.signal/);
        assert.doesNotMatch(code, /emotionalSignal:\s*'neutral'/);
        assert.doesNotMatch(code, /confidence:/);
        assert.match(code, /intent:\s*detectIntent\(text\)\.intent/);
        assert.match(code, /responseDepth:\s*detectResponseDepth\(text\)\.depth/);
        assert.match(code, /mode:\s*detectPersonalityMode\(text\)\.mode/);
        assert.equal(fetchCalls, 0);
    });
});
