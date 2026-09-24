// Part 7E: ConversationManager personality-mode integration.
import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
globalThis.window = { speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; } }, open() {}, SpeechRecognition: undefined, webkitSpeechRecognition: undefined, AudioContext: undefined, webkitAudioContext: undefined };
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: undefined, permissions: undefined }, configurable: true });
globalThis.document = { createElement() { return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return null; }, getContext() { return null; } }; }, body: { appendChild() {}, removeChild() {} }, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {} };
globalThis.Blob = class { constructor() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => { const h = nativeSetInterval(...args); h?.unref?.(); return h; };
globalThis.fetch = async () => { throw new Error('Unexpected network access'); };

const { conversation } = await import('../js/conversation.js');
const { aiBrain } = await import('../js/ai/aiBrain.js');
const { detectPersonalityMode } = await import('../js/ai/personalityModeDetector.js');
const { detectIntent } = await import('../js/ai/intentDetector.js');
const { detectResponseDepth } = await import('../js/ai/responseDepthDetector.js');
globalThis.setInterval = nativeSetInterval;

function stubBrain() {
    const original = aiBrain.processRequest;
    const calls = [];
    aiBrain.processRequest = async (text, options) => { calls.push({ text, options }); return { success: true, isMultiStep: false, response: 'ok' }; };
    return { calls, restore() { aiBrain.processRequest = original; } };
}

describe('ConversationManager Part 7E integration', { concurrency: 1 }, () => {
    beforeEach(() => conversation.clearHistory());

    test('forwards exactly detectPersonalityMode(text).mode; other fields unchanged', async () => {
        const stub = stubBrain();
        const inputs = ['Teach me photosynthesis in detail', 'be playful and keep me safe', "I'm sad.", 'What is quantum mechanics?', 'Explain this in detail.'];
        try {
            for (const t of inputs) await conversation._processWithSkills(t, null, 'voice');
            assert.equal(stub.calls.length, inputs.length);
            stub.calls.forEach((call, i) => {
                const ctx = call.options.interactionContext;
                assert.equal(ctx.mode, detectPersonalityMode(call.text).mode);
                assert.equal(ctx.intent, detectIntent(call.text).intent);
                assert.equal(ctx.responseDepth, detectResponseDepth(call.text).depth);
                assert.equal(ctx.turnType, i === 0 ? 'new' : 'follow_up');
                assert.equal(ctx.emotionalSignal, 'neutral');
                assert.equal(ctx.source, 'voice');
            });
            assert.deepEqual(stub.calls.map(c => c.options.interactionContext.mode), ['teacher', 'guardian', null, null, null]);
        } finally { stub.restore(); }
    });

    test('text source preserved with explicit mode', async () => {
        const stub = stubBrain();
        try {
            await conversation._processWithSkills('focus mode please', null, 'text');
            const ctx = stub.calls[0].options.interactionContext;
            assert.equal(ctx.mode, 'focus');
            assert.equal(ctx.source, 'text');
            assert.equal(ctx.turnType, 'new');
        } finally { stub.restore(); }
    });

    test('wiring uses only detectPersonalityMode(text).mode', async () => {
        const { readFile } = await import('node:fs/promises');
        const src = await readFile(new URL('../js/conversation.js', import.meta.url), 'utf8');
        assert.match(src, /import\s*\{\s*detectPersonalityMode\s*\}\s*from\s*['"]\.\/ai\/personalityModeDetector\.js['"]/);
        assert.match(src, /mode:\s*detectPersonalityMode\(text\)\.mode/);
        assert.doesNotMatch(src, /\bmode:\s*null/);
        assert.match(src, /emotionalSignal:\s*'neutral'/);
    });
});
