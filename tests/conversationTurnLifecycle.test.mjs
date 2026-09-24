// Part 7A: Deterministic Conversation Turn Lifecycle
// Run: node --test tests/conversationTurnLifecycle.test.mjs
//
// Focused tests for ConversationManager turn lifecycle tracker.
// - First command => turnType "new"
// - Subsequent => "follow_up"
// - clearHistory() resets to "new"
// - source preserved text/voice
// - remaining fixed fields unchanged (emotionalSignal; cue-free requests
//   also keep the Part 7C/7D/7E detector defaults)
// - no network access
import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, test } from 'node:test';

// Browser globals must exist before app modules are imported.
globalThis.localStorage = {
    _d: {},
    getItem(key) { return this._d[key] ?? null; },
    setItem(key, value) { this._d[key] = String(value); },
    removeItem(key) { delete this._d[key]; }
};
globalThis.window = {
    speechSynthesis: {
        cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; }
    },
    open() {},
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
    AudioContext: undefined,
    webkitAudioContext: undefined
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: undefined, permissions: undefined },
    configurable: true
});
globalThis.document = {
    createElement() {
        return {
            style: {}, setAttribute() {}, click() {},
            classList: { add() {}, remove() {} },
            appendChild() {}, querySelector() { return null; },
            getContext() { return null; }
        };
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};
globalThis.Blob = class { constructor() {} };
const NativeURL = globalThis.URL;
globalThis.URL = class URL extends NativeURL {
    static createObjectURL() { return 'blob:test'; }
    static revokeObjectURL() {}
};
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
const { createInteractionContext } = await import('../js/ai/interactionContext.js');
const { state } = await import('../js/state.js');

globalThis.setInterval = nativeSetInterval;

function directResponse(text) {
    return { success: true, isMultiStep: false, response: text };
}

function stubProcessRequest(handler) {
    const original = aiBrain.processRequest;
    const calls = [];
    let notify = () => {};
    const completed = new Promise((resolve) => { notify = resolve; });
    aiBrain.processRequest = async (text, options) => {
        calls.push({ text, options });
        try {
            return await handler(text, options);
        } finally {
            notify();
        }
    };
    return {
        calls,
        completed,
        restore() { aiBrain.processRequest = original; }
    };
}

async function withStub(handler, fn) {
    const stub = stubProcessRequest(handler);
    try {
        return await fn(stub);
    } finally {
        stub.restore();
    }
}

describe('ConversationManager deterministic turn lifecycle (Part 7A)', { concurrency: 1 }, () => {
    beforeEach(() => {
        // Reset turn lifecycle and history before each test
        conversation.clearHistory();
        // Ensure internal flag is reset (clearHistory does it, but be explicit for safety)
        // Also clear state conversation for isolation
        state.clearConversation?.();
        if (typeof state.clearConversation === 'function') {
            // state.clearConversation exists in some versions
        }
        fetchCalls = 0;
    });

    afterEach(() => {
        assert.equal(fetchCalls, 0, 'Part 7A tests must not perform network access');
    });

    test('A. First text command → turnType \"new\"', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            const result = await conversation._processWithSkills('hello first', null, 'text');
            assert.equal(stub.calls.length, 1);
            const ctx = stub.calls[0].options.interactionContext;
            assert.equal(ctx.turnType, 'new', 'first command should be new');
            assert.equal(ctx.source, 'text');
            assert.equal(result.response, 'ok');
        });
    });

    test('B. Second text command → turnType \"follow_up\"', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            await conversation._processWithSkills('first message', null, 'text');
            await conversation._processWithSkills('second message', null, 'text');

            assert.equal(stub.calls.length, 2);
            assert.equal(stub.calls[0].options.interactionContext.turnType, 'new');
            assert.equal(stub.calls[1].options.interactionContext.turnType, 'follow_up', 'second command should be follow_up');
            assert.equal(stub.calls[1].options.interactionContext.source, 'text');
        });
    });

    test('C. First voice command → turnType \"new\"', async () => {
        await withStub(async () => directResponse('voice ok'), async (stub) => {
            const result = await conversation._processWithSkills('hello voice', null, 'voice');
            assert.equal(stub.calls.length, 1);
            const ctx = stub.calls[0].options.interactionContext;
            assert.equal(ctx.turnType, 'new');
            assert.equal(ctx.source, 'voice');
        });
    });

    test('D. Subsequent voice command → turnType \"follow_up\"', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            await conversation._processWithSkills('first voice', null, 'voice');
            await conversation._processWithSkills('second voice', null, 'voice');

            assert.equal(stub.calls.length, 2);
            assert.equal(stub.calls[0].options.interactionContext.turnType, 'new');
            assert.equal(stub.calls[0].options.interactionContext.source, 'voice');
            assert.equal(stub.calls[1].options.interactionContext.turnType, 'follow_up');
            assert.equal(stub.calls[1].options.interactionContext.source, 'voice');
        });
    });

    test('E. clearHistory() resets the next turn to \"new\"', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            await conversation._processWithSkills('first', null, 'text');
            assert.equal(stub.calls[0].options.interactionContext.turnType, 'new');

            await conversation._processWithSkills('second', null, 'text');
            assert.equal(stub.calls[1].options.interactionContext.turnType, 'follow_up');

            conversation.clearHistory();

            await conversation._processWithSkills('third after clear', null, 'text');
            assert.equal(stub.calls.length, 3);
            assert.equal(stub.calls[2].options.interactionContext.turnType, 'new', 'after clearHistory should be new again');
        });
    });

    test('E2. clearHistory resets for voice as well', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            await conversation._processWithSkills('first voice', null, 'voice');
            await conversation._processWithSkills('second voice', null, 'voice');
            assert.equal(stub.calls[1].options.interactionContext.turnType, 'follow_up');

            conversation.clearHistory();

            await conversation._processWithSkills('after clear voice', null, 'voice');
            assert.equal(stub.calls[2].options.interactionContext.turnType, 'new');
        });
    });

    test('F. source remains correctly \"text\"/\"voice\" across lifecycle', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            await conversation._processWithSkills('text first', null, 'text');
            await conversation._processWithSkills('voice second', null, 'voice');
            await conversation._processWithSkills('text third', null, 'text');
            await conversation._processWithSkills('voice fourth', null, 'voice');

            assert.equal(stub.calls[0].options.interactionContext.source, 'text');
            assert.equal(stub.calls[0].options.interactionContext.turnType, 'new');

            assert.equal(stub.calls[1].options.interactionContext.source, 'voice');
            assert.equal(stub.calls[1].options.interactionContext.turnType, 'follow_up');

            assert.equal(stub.calls[2].options.interactionContext.source, 'text');
            assert.equal(stub.calls[2].options.interactionContext.turnType, 'follow_up');

            assert.equal(stub.calls[3].options.interactionContext.source, 'voice');
            assert.equal(stub.calls[3].options.interactionContext.turnType, 'follow_up');
        });
    });

    test('F2. processText and voice path preserve source', async () => {
        const previousSpeak = conversation._onAliceSpeak;
        let spokenTexts = [];
        conversation.onAliceSpeak((t) => { spokenTexts.push(t); });

        try {
            await withStub(async () => directResponse('ok text'), async (stub) => {
                conversation.processText('hello via text');
                await stub.completed;
                assert.equal(stub.calls[0].options.interactionContext.source, 'text');
                assert.equal(stub.calls[0].options.interactionContext.turnType, 'new');
            });

            // Reset for voice path
            conversation.clearHistory();

            await withStub(async () => directResponse('ok voice'), async (stub) => {
                conversation._confirmationActive = false;
                conversation._listenToken = conversation._generation;
                conversation._handleSpeechResult({
                    final: 'hello via voice',
                    interim: '',
                    isComplete: true
                });
                await stub.completed;
                assert.equal(stub.calls[0].options.interactionContext.source, 'voice');
                assert.equal(stub.calls[0].options.interactionContext.turnType, 'new');
            });

            await withStub(async () => directResponse('follow'), async (stub) => {
                conversation._confirmationActive = false;
                conversation._listenToken = conversation._generation;
                conversation._handleSpeechResult({
                    final: 'second voice',
                    interim: '',
                    isComplete: true
                });
                await stub.completed;
                assert.equal(stub.calls[0].options.interactionContext.source, 'voice');
                assert.equal(stub.calls[0].options.interactionContext.turnType, 'follow_up');
            });
        } finally {
            conversation.onAliceSpeak(previousSpeak);
        }
    });

    test('G. Existing fixed context fields remain unchanged', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            await conversation._processWithSkills('first', null, 'text');
            await conversation._processWithSkills('second', null, 'voice');

            for (const call of stub.calls) {
                const ctx = call.options.interactionContext;
                assert.equal(ctx.intent, 'unknown', 'intent must stay unknown');
                assert.equal(ctx.responseDepth, 'quick', 'responseDepth must stay quick');
                assert.equal(ctx.mode, null, 'mode must stay null');
                assert.equal(ctx.emotionalSignal, 'neutral', 'emotionalSignal must stay neutral');
                // Verify factory object is frozen and has exact keys
                assert.equal(Object.isFrozen(ctx), true);
                assert.deepEqual(Object.keys(ctx).sort(), [
                    'emotionalSignal', 'intent', 'mode', 'request', 'responseDepth', 'source', 'turnType'
                ]);
            }
        });
    });

    test('G2. createInteractionContext is used and request field stays default', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            // A cue-free request keeps this a lifecycle test, not a detector
            // test: 'What is photosynthesis?' carries no explicit depth or
            // mode cue, so the Part 7D/7E detectors yield quick/null.
            await conversation._processWithSkills('What is photosynthesis?', null, 'text');
            const ctx = stub.calls[0].options.interactionContext;
            // request is factory default '' per existing contract
            assert.equal(ctx.request, '');
            // Must equal factory output for given turnType and source.
            // Part 7C/7D/7E: intent, responseDepth and mode come from the
            // deterministic detectors ('What is photosynthesis?' →
            // information/quick/null); the remaining fields are fixed.
            const expected = createInteractionContext({
                turnType: 'new',
                intent: 'information',
                responseDepth: 'quick',
                mode: null,
                emotionalSignal: 'neutral',
                source: 'text'
            });
            assert.deepEqual(ctx, expected);
            assert.equal(ctx.intent, 'information', 'detected intent is forwarded');
            assert.equal(ctx.responseDepth, 'quick', 'no explicit depth cue keeps the quick default');
            assert.equal(ctx.mode, null, 'no explicit mode cue keeps mode null');
        });
    });

    test('H. No network access', async () => {
        assert.equal(fetchCalls, 0);
        await withStub(async () => directResponse('offline'), async (stub) => {
            await conversation._processWithSkills('test no network', null, 'text');
            assert.equal(stub.calls.length, 1);
        });
        assert.equal(fetchCalls, 0);
    });

    test('turn lifecycle is deterministic, not semantic', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            // Even unrelated topics should be follow_up after first
            await conversation._processWithSkills('What is the weather?', null, 'text');
            await conversation._processWithSkills('Calculate 2 plus 2', null, 'text');
            await conversation._processWithSkills('Tell me a joke', null, 'text');

            assert.equal(stub.calls[0].options.interactionContext.turnType, 'new');
            assert.equal(stub.calls[1].options.interactionContext.turnType, 'follow_up');
            assert.equal(stub.calls[2].options.interactionContext.turnType, 'follow_up');
        });
    });

    test('lifecycle state is maintained via private field and reset by clearHistory', async () => {
        // Verify the field exists and is private (convention) and boolean
        assert.equal(typeof conversation._hasHadInteraction, 'boolean');
        conversation.clearHistory();
        assert.equal(conversation._hasHadInteraction, false);

        await withStub(async () => directResponse('ok'), async (stub) => {
            await conversation._processWithSkills('first', null, 'text');
            assert.equal(conversation._hasHadInteraction, true);
            assert.equal(stub.calls[0].options.interactionContext.turnType, 'new');
        });

        conversation.clearHistory();
        assert.equal(conversation._hasHadInteraction, false);
    });
});
