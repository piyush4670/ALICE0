// Part 7C: ConversationManager → deterministic intent detection integration.
// Run: node --test tests/conversationIntentIntegration.test.mjs
//
// Focused ConversationManager tests only. AIBrain.processRequest is stubbed
// so the HTTP adapter never runs — zero network access, verified with a
// fetch spy. Verifies that:
//   - obvious requests receive the detected intent in InteractionContext
//   - ambiguous requests still receive "unknown"
//   - the other context fields follow the current contract: turnType from
//     the Part 7A lifecycle, source from the entry path, responseDepth from
//     the Part 7D detector and mode from the Part 7E detector (both for the
//     exact request text), emotionalSignal fixed at "neutral"
//   - detection never executes a skill, the agent, or any permission gate
//   - a detector failure falls back to unknown/low and never crashes
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';

// Browser globals must exist before app modules are imported.
globalThis.localStorage = {
    _d: {}, getItem(key) { return this._d[key] ?? null; },
    setItem(key, value) { this._d[key] = String(value); },
    removeItem(key) { delete this._d[key]; }
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
const { agent } = await import('../js/agent.js');
const { permissions } = await import('../js/permissions.js');
const { skillManager } = await import('../js/skillManager.js');
const { state } = await import('../js/state.js');
const { detectIntent } = await import('../js/ai/intentDetector.js');
const { detectResponseDepth } = await import('../js/ai/responseDepthDetector.js');
const { detectPersonalityMode } = await import('../js/ai/personalityModeDetector.js');
const { createInteractionContext } = await import('../js/ai/interactionContext.js');

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

/** Assert the full InteractionContext contract for a forwarded call. */
function assertContextShape(ctx, { text, intent, source = 'text', turnType = 'new' }) {
    assert.ok(ctx && typeof ctx === 'object', 'interactionContext must be an object');
    assert.equal(Object.isFrozen(ctx), true, 'interactionContext must be frozen');
    assert.deepEqual(Object.keys(ctx).sort(), [
        'emotionalSignal', 'intent', 'mode', 'request', 'responseDepth', 'source', 'turnType'
    ]);
    assert.equal(ctx.intent, intent, `intent for "${text}"`);
    assert.equal(ctx.turnType, turnType, 'turnType comes from the Part 7A lifecycle');
    assert.equal(ctx.source, source, 'source comes from the entry path');
    // Part 7D/7E: responseDepth and mode are exactly the deterministic
    // detectors' verdicts for this exact request text.
    const expectedDepth = detectResponseDepth(text).depth;
    const expectedMode = detectPersonalityMode(text).mode;
    assert.equal(ctx.responseDepth, expectedDepth,
        `responseDepth must equal detectResponseDepth(${JSON.stringify(text)}).depth`);
    assert.equal(ctx.mode, expectedMode,
        `mode must equal detectPersonalityMode(${JSON.stringify(text)}).mode`);
    assert.equal(ctx.emotionalSignal, 'neutral', 'emotionalSignal remains neutral');
    assert.equal(ctx.request, '', 'factory request normalization unchanged');
    // The context must equal the pure factory output for these values.
    assert.deepEqual(ctx, createInteractionContext({
        turnType, intent, responseDepth: expectedDepth, mode: expectedMode,
        emotionalSignal: 'neutral', source
    }));
}

describe('ConversationManager intent detection integration (Part 7C)', { concurrency: 1 }, () => {
    beforeEach(() => {
        conversation.clearHistory();
    });

    afterEach(() => {
        assert.equal(fetchCalls, 0, 'Part 7C tests must not perform network access');
        assert.equal(aiBrain.isEnabled(), true, 'a test left AI Brain disabled');
    });

    // --- P. ConversationManager integration ---------------------------------
    test('P. obvious information request receives the detected intent', async () => {
        await withStub(async () => directResponse('Plants use light.'), async (stub) => {
            await conversation._processWithSkills('What is photosynthesis?', null, 'text');
            assert.equal(stub.calls.length, 1);
            assertContextShape(stub.calls[0].options.interactionContext, {
                text: 'What is photosynthesis?', intent: 'information', turnType: 'new'
            });
            // Part 7D/7E: a plain question carries no explicit depth or mode
            // cue, so it keeps the default depth and no mode.
            assert.equal(stub.calls[0].options.interactionContext.responseDepth, 'quick');
            assert.equal(stub.calls[0].options.interactionContext.mode, null);
        });
    });

    test('P. obvious action request receives the detected intent', async () => {
        await withStub(async () => directResponse('100'), async (stub) => {
            await conversation._processWithSkills('Calculate 25 times 4', null, 'text');
            assertContextShape(stub.calls[0].options.interactionContext, {
                text: 'Calculate 25 times 4', intent: 'action', turnType: 'new'
            });
        });
    });

    test('P. obvious conversation request receives the detected intent', async () => {
        await withStub(async () => directResponse('Hello!'), async (stub) => {
            await conversation._processWithSkills('Good morning', null, 'voice');
            assertContextShape(stub.calls[0].options.interactionContext, {
                text: 'Good morning', intent: 'conversation', source: 'voice', turnType: 'new'
            });
        });
    });

    test('P. obvious clarification request receives the detected intent', async () => {
        await withStub(async () => directResponse('Sure, again: ...'), async (stub) => {
            await conversation._processWithSkills('What do you mean?', null, 'text');
            assertContextShape(stub.calls[0].options.interactionContext, {
                text: 'What do you mean?', intent: 'clarification', turnType: 'new'
            });
        });
    });

    test('P. ambiguous request still receives "unknown" with low detector confidence', async () => {
        const ambiguous = 'purple elephants danced quietly';
        assert.deepEqual(detectIntent(ambiguous),
            { intent: 'unknown', confidence: 'low' }, 'precondition: detector is unsure');
        await withStub(async () => directResponse('Hmm.'), async (stub) => {
            await conversation._processWithSkills(ambiguous, null, 'text');
            assertContextShape(stub.calls[0].options.interactionContext, {
                text: ambiguous, intent: 'unknown', turnType: 'new'
            });
        });
    });

    test('P. detected intent coexists with the Part 7A lifecycle and source behavior', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            await conversation._processWithSkills('Explain quantum computing', null, 'text');
            await conversation._processWithSkills('Open YouTube', null, 'voice');
            await conversation._processWithSkills('Hey Alice', null, 'text');
            conversation.clearHistory();
            await conversation._processWithSkills('What do you mean?', null, 'voice');

            assert.equal(stub.calls.length, 4);
            assertContextShape(stub.calls[0].options.interactionContext, {
                text: 'Explain quantum computing', intent: 'information', turnType: 'new'
            });
            // Part 7D: the explicit "explain" cue raises the depth without a
            // mode cue; the other requests stay at the quick/no-mode default.
            assert.equal(stub.calls[0].options.interactionContext.responseDepth, 'explain');
            assert.equal(stub.calls[0].options.interactionContext.mode, null);
            assertContextShape(stub.calls[1].options.interactionContext, {
                text: 'Open YouTube', intent: 'action', source: 'voice', turnType: 'follow_up'
            });
            assertContextShape(stub.calls[2].options.interactionContext, {
                text: 'Hey Alice', intent: 'conversation', turnType: 'follow_up'
            });
            assertContextShape(stub.calls[3].options.interactionContext, {
                text: 'What do you mean?', intent: 'clarification', source: 'voice', turnType: 'new'
            });
        });
    });

    test('P. every forwarded intent also satisfies the detectIntent contract', async () => {
        const requests = [
            'What is photosynthesis?', 'Open YouTube', 'Good morning',
            'Can you clarify?', '', // blank never reaches here; listed for contract only
            'the weather seems nice today'
        ].filter((t) => t.length > 0);
        await withStub(async () => directResponse('ok'), async (stub) => {
            for (const request of requests) {
                await conversation._processWithSkills(request, null, 'text');
            }
            assert.equal(stub.calls.length, requests.length);
            for (const call of stub.calls) {
                const forwarded = call.options.interactionContext.intent;
                const expected = detectIntent(call.text);
                assert.equal(forwarded, expected.intent,
                    `forwarded intent must equal detectIntent("${call.text}")`);
                assert.ok(['information', 'action', 'conversation', 'clarification', 'unknown']
                    .includes(forwarded));
            }
        });
    });

    // --- Q. Detection has no side effects -----------------------------------
    test('Q. detection does not execute skills, the agent, or the permission gateway', async () => {
        let executePlanCalls = 0;
        let agentProcessCalls = 0;
        let skillExecutions = 0;
        let gateCalls = 0;
        const originalExecutePlan = agent.executePlan;
        const originalProcess = agent.process;
        const originalExecuteByName = skillManager.executeByName;
        const originalGate = permissions.gate;
        agent.executePlan = async (...args) => { executePlanCalls += 1; return originalExecutePlan.apply(agent, args); };
        agent.process = async (...args) => { agentProcessCalls += 1; return originalProcess.apply(agent, args); };
        skillManager.executeByName = async (...args) => { skillExecutions += 1; return originalExecuteByName.apply(skillManager, args); };
        permissions.gate = async (...args) => { gateCalls += 1; return originalGate.apply(permissions, args); };

        try {
            await withStub(async () => directResponse('Direct answer, no tools.'), async (stub) => {
                for (const request of ['Open YouTube', 'Calculate 25 times 4', 'Set a reminder']) {
                    await conversation._processWithSkills(request, null, 'text');
                }
                assert.equal(stub.calls.length, 3);
                for (const call of stub.calls) {
                    assert.equal(call.options.interactionContext.intent, 'action');
                }
                assert.equal(executePlanCalls, 0, 'detection must not run agent.executePlan');
                assert.equal(agentProcessCalls, 0, 'detection must not run agent.process');
                assert.equal(skillExecutions, 0, 'detection must not execute any skill');
                assert.equal(gateCalls, 0, 'detection must not touch the permission gateway');
                assert.equal(fetchCalls, 0);
            });
        } finally {
            agent.executePlan = originalExecutePlan;
            agent.process = originalProcess;
            skillManager.executeByName = originalExecuteByName;
            permissions.gate = originalGate;
        }
    });

    test('Q. permission and skill behavior are unchanged for a detected action request', async () => {
        state.resetTask();
        let gateCalls = 0;
        const originalGate = permissions.gate;
        permissions.gate = async function (...args) {
            gateCalls += 1;
            return originalGate.apply(permissions, args);
        };
        try {
            // When the normal pipeline DOES execute a plan, the permission
            // gateway still runs exactly as before — intent detection changed
            // nothing about permission behavior.
            await withStub(async () => ({
                success: true,
                isMultiStep: true,
                goal: 'Calculate 2 plus 2',
                plan: [{ id: 'step1', skill: 'calculator', input: '2 plus 2', label: 'Calculate' }]
            }), async (stub) => {
                const result = await conversation._processWithSkills('Calculate 2 plus 2', null, 'text');
                assert.equal(stub.calls[0].options.interactionContext.intent, 'action');
                assert.match(result.response, /4/);
                assert.ok(gateCalls >= 1, 'Permission Gateway must still run for real executions');
                assert.equal(state.getTask().status, 'completed');
            });
        } finally {
            permissions.gate = originalGate;
            state.resetTask();
        }
    });

    test('Q. detector never being able to crash ConversationManager: exotic input falls back', async () => {
        await withStub(async () => directResponse('ok'), async (stub) => {
            // Non-text noise still flows through the normal pipeline, the
            // detector returns unknown/low internally, and nothing throws.
            for (const request of ['\u{1F600}\u{1F4A1} ???', '\u0000\u0001weird\u0002', 'x'.repeat(5000)]) {
                const result = await conversation._processWithSkills(request, null, 'text');
                assert.ok(result && typeof result.response === 'string');
            }
            assert.equal(stub.calls.length, 3);
            for (const call of stub.calls) {
                const intent = call.options.interactionContext.intent;
                assert.ok(['information', 'action', 'conversation', 'clarification', 'unknown']
                    .includes(intent), `exotic input produced invalid intent: ${intent}`);
            }
        });

        // The detector itself swallows internal failures conservatively.
        const pathologicalInputs = [
            new Proxy({}, { get() { throw new Error('boom'); } }),
            { toString() { throw new Error('boom'); } }
        ];
        for (const input of pathologicalInputs) {
            assert.deepEqual(detectIntent(input), { intent: 'unknown', confidence: 'low' });
        }
    });

    // --- Integration wiring is minimal and scoped ---------------------------
    test('conversation.js wires exactly one detector call per detected field into the context factory', async () => {
        const source = await readFile(new URL('../js/conversation.js', import.meta.url), 'utf8');
        const code = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');

        assert.match(source,
            /import\s*\{\s*detectIntent\s*\}\s*from\s*['"]\.\/ai\/intentDetector\.js['"]/);
        assert.equal(
            code.match(/detectIntent\s*\(/g).length,
            1,
            'there is exactly one detectIntent call'
        );
        assert.match(source,
            /import\s*\{\s*detectResponseDepth\s*\}\s*from\s*['"]\.\/ai\/responseDepthDetector\.js['"]/);
        assert.equal(
            code.match(/detectResponseDepth\s*\(/g).length,
            1,
            'there is exactly one detectResponseDepth call'
        );
        assert.match(source,
            /import\s*\{\s*detectPersonalityMode\s*\}\s*from\s*['"]\.\/ai\/personalityModeDetector\.js['"]/);
        assert.equal(
            code.match(/detectPersonalityMode\s*\(/g).length,
            1,
            'there is exactly one detectPersonalityMode call'
        );
        assert.equal(
            code.match(/createInteractionContext\s*\(/g).length,
            1,
            'createInteractionContext() remains the single context factory call'
        );
        assert.match(code, /intent:\s*detectIntent\(text\)\.intent/,
            'intent must come from detectIntent(text)');
        assert.match(code, /responseDepth:\s*detectResponseDepth\(text\)\.depth/,
            'responseDepth must come from detectResponseDepth(text) (Part 7D)');
        assert.match(code, /mode:\s*detectPersonalityMode\(text\)\.mode/,
            'mode must come from detectPersonalityMode(text) (Part 7E)');
        // The hardcoded placeholders are gone; the fixed safe default remains.
        assert.doesNotMatch(code, /intent:\s*'unknown'/);
        assert.doesNotMatch(code, /responseDepth:\s*'quick'/);
        assert.doesNotMatch(code, /mode:\s*null/);
        assert.match(code, /emotionalSignal:\s*'neutral'/);
        assert.match(code, /source\b/);
        // Detection happens at the integration point, never inside the factory.
        assert.match(code, /_hasHadInteraction/);
        assert.doesNotMatch(code, /detectEmotion|classifyIntent|sentiment|selectMode|selectDepth/);
        assert.doesNotMatch(source, /from\s*['"]\.\/ai\/httpModelAdapter\.js['"]/);
        assert.doesNotMatch(source, /gateway\.js/);
    });

    test('the InteractionContext factory itself still never detects intent', async () => {
        // createInteractionContext remains a pure normalization contract:
        // supplying request text alone can never produce a non-unknown intent.
        const ctx = createInteractionContext({ request: 'Open YouTube' });
        assert.equal(ctx.intent, 'unknown');
        assert.deepEqual(ctx, createInteractionContext({ request: 'Open YouTube' }));
        // …and the same input with no request yields the plain defaults.
        assert.deepEqual(createInteractionContext(), createInteractionContext({}));

        const factorySource = await readFile(
            new URL('../js/ai/interactionContext.js', import.meta.url), 'utf8');
        assert.doesNotMatch(factorySource, /detectIntent/);
        assert.doesNotMatch(factorySource, /intentDetector/);
    });
});
