// Part 7D: ConversationManager response-depth integration.
import assert from 'node:assert/strict';
import { test, describe, beforeEach, afterEach } from 'node:test';

// Minimal browser shims required by the browser-oriented conversation module.
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
globalThis.setInterval = (...args) => { const handle = nativeSetInterval(...args); handle?.unref?.(); return handle; };
globalThis.fetch = async () => { throw new Error('Unexpected network access'); };

const { conversation } = await import('../js/conversation.js');
const { aiBrain } = await import('../js/ai/aiBrain.js');
const { detectResponseDepth } = await import('../js/ai/responseDepthDetector.js');
globalThis.setInterval = nativeSetInterval;

function stubBrain() {
    const original = aiBrain.processRequest;
    const calls = [];
    aiBrain.processRequest = async (text, options) => { calls.push({ text, options }); return { success: true, isMultiStep: false, response: 'ok' }; };
    return { calls, restore() { aiBrain.processRequest = original; } };
}

describe('ConversationManager Part 7D integration', { concurrency: 1 }, () => {
    beforeEach(() => conversation.clearHistory());
    afterEach(() => { assert.equal(aiBrain.isEnabled(), true); });

    test('forwards detector depth while preserving Part 7A, 6, and 7C fields', async () => {
        const stub = stubBrain();
        try {
            await conversation._processWithSkills('Explain this in detail', null, 'voice');
            const ctx = stub.calls[0].options.interactionContext;
            assert.equal(ctx.responseDepth, detectResponseDepth(stub.calls[0].text).depth);
            assert.equal(ctx.responseDepth, 'deep');
            assert.equal(ctx.intent, 'information');
            assert.equal(ctx.turnType, 'new');
            assert.equal(ctx.source, 'voice');
            assert.equal(ctx.mode, null);
            assert.equal(ctx.emotionalSignal, 'neutral');
        } finally { stub.restore(); }
    });

    test('explicit quick and explain cues are forwarded; lifecycle remains deterministic', async () => {
        const stub = stubBrain();
        try {
            await conversation._processWithSkills('What is photosynthesis? Just the answer', null, 'text');
            await conversation._processWithSkills('Explain this with an example', null, 'text');
            assert.equal(stub.calls[0].options.interactionContext.responseDepth, 'quick');
            assert.equal(stub.calls[1].options.interactionContext.responseDepth, 'explain');
            assert.equal(stub.calls[0].options.interactionContext.turnType, 'new');
            assert.equal(stub.calls[1].options.interactionContext.turnType, 'follow_up');
            for (const call of stub.calls) {
                const ctx = call.options.interactionContext;
                assert.equal(ctx.mode, null);
                assert.equal(ctx.emotionalSignal, 'neutral');
                assert.equal(ctx.responseDepth, detectResponseDepth(call.text).depth);
            }
        } finally { stub.restore(); }
    });

    test('integration wiring uses only detectResponseDepth(text).depth', async () => {
        const { readFile } = await import('node:fs/promises');
        const source = await readFile(new URL('../js/conversation.js', import.meta.url), 'utf8');
        assert.match(source, /import\s*\{\s*detectResponseDepth\s*\}\s*from\s*['"]\.\/ai\/responseDepthDetector\.js['"]/);
        assert.match(source, /responseDepth:\s*detectResponseDepth\(text\)\.depth/);
        assert.doesNotMatch(source, /responseDepth:\s*'quick'/);
    });
});
