// Part 9B — Context-Aware Final Response Synthesis (focused tests).
// Run: node --test tests/part9b-context-aware-final-response.test.mjs
//
// Scope: ONLY the final response synthesis path (AIBrain.generateResponse).
// No detector, personality, guidance, skill, agent, permission-gateway, UI,
// STT/TTS, or memory behavior is exercised or changed here.
//
// Test doubles: a recording ContextBuilder stub, a spy-wrapped REAL
// ContextBuilder, and fake in-process model adapters. Zero network access is
// verified with a fetch spy; no Groq/provider credentials are required.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Browser-only globals needed by the production singleton imports.
globalThis.localStorage = {
    _d: {},
    getItem(key) { return this._d[key] ?? null; },
    setItem(key, value) { this._d[key] = String(value); },
    removeItem(key) { delete this._d[key]; }
};
globalThis.document = {
    createElement() {
        return {
            style: {}, setAttribute() {}, click() {},
            classList: { add() {}, remove() {} },
            appendChild() {}, querySelector() { return null; }
        };
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; }
};
globalThis.Blob = class { constructor() {} };
// Keep the native URL constructor (needed for new URL(...)/import.meta.url)
// while providing the blob helpers the memory module uses for exports.
const NativeURL = globalThis.URL;
globalThis.URL = class URL extends NativeURL {
    static createObjectURL() { return 'blob:test'; }
    static revokeObjectURL() {}
};

// The real ContextBuilder's memory adapter starts its normal reminder timer;
// unref it so this focused test process can exit on its own.
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
    const handle = nativeSetInterval(...args);
    handle?.unref?.();
    return handle;
};

const { AIBrain } = await import('../js/ai/aiBrain.js');
const { ModelAdapter } = await import('../js/ai/modelAdapter.js');
const { MockAdapter } = await import('../js/ai/mockAdapter.js');
const { contextBuilder: realContextBuilder } = await import('../js/ai/contextBuilder.js');
const { createInteractionContext } = await import('../js/ai/interactionContext.js');
const { getEmotionalResponseGuidance } = await import('../js/ai/emotionalResponseGuidance.js');
const { state } = await import('../js/state.js');
const { memory } = await import('../js/memory.js');
const { CONFIG } = await import('../js/config.js');
globalThis.setInterval = nativeSetInterval;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** ContextBuilder stub that records every buildContext()/formatForPrompt() call. */
function createRecordingContextBuilder({ onBuild } = {}) {
    const buildCalls = [];
    const formatCalls = [];
    return {
        buildCalls,
        formatCalls,
        buildContext(options = {}) {
            buildCalls.push(options);
            if (onBuild) return onBuild(options);
            return { request: options.request, tools: [], interactionContext: options.interactionContext };
        },
        formatForPrompt(context, options) {
            formatCalls.push({ context, options });
            return `FORMATTED CONTEXT(${context?.request ?? ''})`;
        }
    };
}

/** Spy-wrapped REAL ContextBuilder: delegates to production, records arguments. */
function createSpyContextBuilder(inner = realContextBuilder) {
    const buildCalls = [];
    const formatCalls = [];
    return {
        buildCalls,
        formatCalls,
        buildContext(options = {}) {
            const value = inner.buildContext(options);
            buildCalls.push({ options, value });
            return value;
        },
        formatForPrompt(context, options) {
            const value = inner.formatForPrompt(context, options);
            formatCalls.push({ context, options, value });
            return value;
        }
    };
}

/** ModelAdapter stub that records every generate() call and returns canned output. */
class RecordingAdapter extends ModelAdapter {
    constructor(config = {}) {
        super(config);
        this.generateCalls = [];
        this.nextResult = { text: 'Synthesized natural-language reply.' };
        this.failure = null;
    }

    async generate(prompt, options = {}) {
        this.generateCalls.push({ prompt, options });
        if (this.failure) throw this.failure;
        return typeof this.nextResult === 'function' ? this.nextResult(prompt, options) : this.nextResult;
    }
}

const EXAMPLE_REQUEST = 'Summarize the quantum computing research you gathered.';
const EXAMPLE_EXECUTION_RESULT = {
    skill: 'core',
    operation: 'summarize',
    status: 'completed',
    response: 'Quantum computing uses qubits and superposition.',
    data: { words: 812, sections: 4 }
};

const EXAMPLE_INTERACTION_CONTEXT = Object.freeze({
    turnType: 'follow_up',
    intent: 'information',
    responseDepth: 'deep',
    mode: 'analyst',
    emotionalSignal: 'curious',
    source: 'voice'
});

/** A context built by the REAL ContextBuilder, with tools, memory, history and task state. */
function buildRichRealContext() {
    const pinned = memory.pinFact('The user prefers concise answers.');
    state.clearConversation();
    state.addToConversation('user', 'Earlier: search for quantum computing research.');
    state.addToConversation('assistant', 'Earlier: I found four relevant sources.');
    state.setTask({ active: true, status: 'running', currentAction: 'Summarizing research', progress: 40 });
    try {
        const context = realContextBuilder.buildContext({
            request: EXAMPLE_REQUEST,
            interactionContext: createInteractionContext(EXAMPLE_INTERACTION_CONTEXT)
        });
        assert.ok(context.tools.length > 0, 'test fixture: expected registered tools');
        return context;
    } finally {
        state.clearConversation();
        state.resetTask();
        memory.unpinFact(pinned.id);
    }
}

// ---------------------------------------------------------------------------
// 1) A supplied context is formatted as-is: never rebuilt, never mutated
// ---------------------------------------------------------------------------

test('a supplied context reaches the synthesis prompt verbatim and is never rebuilt', async () => {
    const contextBuilderStub = createRecordingContextBuilder();
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderStub });

    const suppliedContext = {
        request: EXAMPLE_REQUEST,
        history: [],
        memory: { memories: [], pinnedFacts: [], preferences: {}, recentTasks: [] },
        tools: [],
        taskState: { active: false, status: 'idle', currentAction: '' },
        interactionContext: createInteractionContext(EXAMPLE_INTERACTION_CONTEXT),
        timestamp: 123
    };
    const snapshot = JSON.parse(JSON.stringify(suppliedContext));

    const response = await brain.generateResponse(
        EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, suppliedContext
    );

    assert.equal(response, 'Synthesized natural-language reply.');
    assert.equal(contextBuilderStub.buildCalls.length, 0, 'a supplied context must never be rebuilt');
    assert.equal(contextBuilderStub.formatCalls.length, 1, 'the context must be formatted exactly once');
    // Same reference and same values: the supplied context is used, not copied.
    assert.strictEqual(contextBuilderStub.formatCalls[0].context, suppliedContext);
    assert.deepEqual(contextBuilderStub.formatCalls[0].options, { responseContract: 'presentation' });
    assert.deepEqual(suppliedContext, snapshot, 'the supplied context must not be mutated');
    // And the formatted context is what the model actually receives.
    assert.match(adapter.generateCalls[0].prompt, /FORMATTED CONTEXT\(/);
    assert.ok(
        adapter.generateCalls[0].prompt.includes(contextBuilderStub.formatCalls[0].context.request),
        'the formatted context must be embedded in the synthesis prompt'
    );
});

test('a supplied context is not mutated, even if it is frozen', async () => {
    const contextBuilderStub = createRecordingContextBuilder();
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderStub });

    const suppliedContext = Object.freeze({
        request: EXAMPLE_REQUEST,
        interactionContext: createInteractionContext(EXAMPLE_INTERACTION_CONTEXT),
        memory: Object.freeze({ memories: [], pinnedFacts: [], preferences: {}, recentTasks: [] }),
        history: Object.freeze([]),
        tools: Object.freeze([]),
        taskState: Object.freeze({ active: false, status: 'idle', currentAction: '' }),
        timestamp: 456
    });

    // ES modules are strict mode: any mutation attempt on a frozen context throws.
    await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, suppliedContext);

    assert.ok(Object.isFrozen(suppliedContext));
    assert.equal(suppliedContext.request, EXAMPLE_REQUEST);
    assert.equal(suppliedContext.interactionContext.intent, 'information');
    assert.equal(contextBuilderStub.buildCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 2) The rich ContextBuilder context reaches the synthesis prompt
// ---------------------------------------------------------------------------

test('every established context section reaches the synthesis prompt', async () => {
    const contextBuilderSpy = createSpyContextBuilder();
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderSpy });
    const context = buildRichRealContext();

    await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, context);

    const prompt = adapter.generateCalls[0].prompt;

    // The production formatter ran on exactly the supplied context, and the
    // synthesis prompt starts with that formatted context (nothing reordered
    // or dropped in between).
    assert.equal(contextBuilderSpy.formatCalls.length, 1);
    assert.strictEqual(contextBuilderSpy.formatCalls[0].context, context);
    assert.deepEqual(contextBuilderSpy.formatCalls[0].options, { responseContract: 'presentation' });
    assert.ok(
        prompt.startsWith(contextBuilderSpy.formatCalls[0].value),
        'the formatted ALICE context must be included verbatim'
    );

    // ALICE Identity
    assert.match(prompt, /ALICE Identity:/);
    assert.match(prompt, /- Name: ALICE\b/);
    assert.match(prompt, /- Persona: /);

    // Interaction Context (explicit caller-supplied metadata, unchanged)
    assert.match(prompt, /Interaction Context:/);
    assert.match(prompt, /- Turn type: follow_up/);
    assert.match(prompt, /- Intent: information/);
    assert.match(prompt, /- Response depth: deep/);
    assert.match(prompt, /- Personality mode: analyst/);
    assert.match(prompt, /- Broad contextual signal: curious/);
    assert.match(prompt, /- Source: voice/);

    // Emotional Response Guidance (deterministic guidance for the same signal)
    assert.match(prompt, /Emotional Response Guidance:/);
    const guidance = getEmotionalResponseGuidance('curious');
    assert.ok(prompt.includes(`- Expressed signal: ${guidance.signal}`));
    assert.ok(prompt.includes(`- Communication tone: ${guidance.tone}`));
    for (const rule of guidance.guidance) {
        assert.ok(prompt.includes(`  - ${rule}`), `missing emotional guidance rule: ${rule}`);
    }

    // Response Priority Contract
    assert.match(prompt, /Response Priority Contract:/);
    assert.ok(prompt.includes("The user's request is the primary task and must be answered or handled first."));
    assert.ok(prompt.includes("Emotional guidance must never replace, reinterpret, or override the user's actual request."));

    // Final synthesis has its own contract, never the planning JSON contract.
    assert.match(prompt, /Final Presentation-Only Response Contract/);
    assert.doesNotMatch(prompt, /Required JSON Output Contract|Return ONLY one JSON object/);
    assert.doesNotMatch(prompt, /\{"response":|\{"goal":/);

    // Tools / memory / history context (task state travels on the same context)
    assert.match(prompt, /Available Tools:/);
    assert.match(prompt, /- core: Internal core processing operations/);
    assert.match(prompt, /Pinned Facts: The user prefers concise answers\./);
    assert.match(prompt, /Conversation History:/);
    assert.ok(prompt.includes('ALICE: Earlier: I found four relevant sources.'));
    assert.ok(context.taskState.active === true, 'task state must remain available on the context');

    // Established section order is preserved.
    const order = [
        'ALICE Identity:',
        'Interaction Context:',
        'Emotional Response Guidance:',
        'Response Priority Contract:',
        'Final Presentation-Only Response Contract:',
        'User Request:'
    ];
    let previous = -1;
    for (const heading of order) {
        const position = prompt.indexOf(heading);
        assert.ok(position > previous, `${heading} missing or out of order in the synthesis prompt`);
        previous = position;
    }
});

test('generatePlan keeps the default JSON planning contract, byte-for-byte', async () => {
    const contextBuilderSpy = createSpyContextBuilder();
    const adapter = new RecordingAdapter();
    adapter.nextResult = { structured: { response: 'Planning direct answer.' } };
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderSpy });
    const context = buildRichRealContext();
    const originalPlanningPrompt = realContextBuilder.formatForPrompt(context);

    const result = await brain.generatePlan(EXAMPLE_REQUEST, context);

    assert.equal(result.response, 'Planning direct answer.');
    assert.equal(contextBuilderSpy.buildCalls.length, 0);
    assert.equal(contextBuilderSpy.formatCalls.length, 1);
    assert.strictEqual(contextBuilderSpy.formatCalls[0].context, context);
    assert.equal(contextBuilderSpy.formatCalls[0].options, undefined,
        'generatePlan must keep the original default formatting call');
    assert.equal(adapter.generateCalls[0].options.responseFormat, 'plan');
    assert.equal(adapter.generateCalls[0].prompt, originalPlanningPrompt);
    assert.equal(realContextBuilder.formatForPrompt(context, { responseContract: 'planning' }), originalPlanningPrompt);
    assert.match(originalPlanningPrompt, /Required JSON Output Contract — your entire reply is machine-parsed/);
    assert.match(originalPlanningPrompt, /Return ONLY one JSON object/);
    assert.match(originalPlanningPrompt, /\{"response": "your natural-language answer"\}/);
    assert.match(originalPlanningPrompt, /\{"goal": "overall user goal"/);
});

// ---------------------------------------------------------------------------
// 3) Request + execution result are both present and correctly prioritized
// ---------------------------------------------------------------------------

test('the original user request and the execution result both reach the synthesis prompt', async () => {
    const contextBuilderSpy = createSpyContextBuilder();
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderSpy });
    const context = realContextBuilder.buildContext({ request: EXAMPLE_REQUEST });

    await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, context);

    const prompt = adapter.generateCalls[0].prompt;

    // Original user request, explicitly labelled and also present in context.
    assert.ok(prompt.includes(`User Request: "${EXAMPLE_REQUEST}"`));
    assert.match(prompt, /- Intent: unknown/);

    // Execution result (the factual tool output).
    assert.ok(prompt.includes(`Execution Result: ${JSON.stringify(EXAMPLE_EXECUTION_RESULT)}`));
    assert.ok(prompt.includes('"status":"completed"'));

    // The request stays authoritative and the result may not override it.
    assert.match(prompt, /Final Response Synthesis/);
    assert.match(prompt, /The user's request is the primary task: answer it exactly as asked\./);
    assert.match(prompt, /never let it replace or reinterpret the request/i);
    // The request is stated after the context, before the execution result.
    assert.ok(prompt.indexOf(`User Request: "${EXAMPLE_REQUEST}"`) < prompt.indexOf('Execution Result: '));

    // Prompt size stays inside the configured gateway limit.
    assert.ok(
        prompt.length <= CONFIG.ai.gateway.maxPromptChars,
        `synthesis prompt is ${prompt.length} chars; limit is ${CONFIG.ai.gateway.maxPromptChars}`
    );
});

test('realistic bounded tools, history, and memory fit the final text prompt', async () => {
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });
    const pinned = [];
    const keys = [];
    state.clearConversation();
    try {
        for (let i = 0; i < 9; i++) {
            state.addToConversation(i % 2 ? 'assistant' : 'user',
                `Research discussion turn ${i + 1}: ` +
                'We reviewed the quantum computing project, its sources, and the results to summarize. '.repeat(3));
        }
        for (let i = 0; i < 3; i++) {
            pinned.push(memory.pinFact(`Research preference ${i + 1}: use concise factual summaries.`));
            const key = `quantum computing research fact ${i + 1}`;
            keys.push(key);
            memory.remember(key, `Verified source ${i + 1} for the project summary.`);
        }

        const context = realContextBuilder.buildContext({ request: EXAMPLE_REQUEST });
        assert.ok(context.tools.length >= 10, 'use actual registered tool descriptors');
        assert.equal(context.history.length, 6, 'ContextBuilder bounds conversation history');
        assert.equal(context.memory.pinnedFacts.length, 3);
        assert.equal(context.memory.memories.length, 3);
        await brain.generateResponse(EXAMPLE_REQUEST,
            { response: EXAMPLE_EXECUTION_RESULT.response, success: true }, context);

        const prompt = adapter.generateCalls[0].prompt;
        assert.match(prompt, /Available Tools:/);
        assert.match(prompt, /Conversation History:/);
        assert.match(prompt, /Context & Memory:/);
        assert.match(prompt, /Verified source 3 for the project summary/);
        assert.match(prompt, /Execution Result: \{"response":"Quantum computing uses qubits and superposition\.\",\"success\":true\}/);
        assert.ok(prompt.length <= CONFIG.ai.gateway.maxPromptChars,
            `final prompt is ${prompt.length} chars; limit is ${CONFIG.ai.gateway.maxPromptChars}`);
    } finally {
        state.clearConversation();
        for (const fact of pinned) memory.unpinFact(fact.id);
        for (const key of keys) memory.forget(key);
    }
});

// ---------------------------------------------------------------------------
// 4) No context supplied: a minimal one is built from the request alone
// ---------------------------------------------------------------------------

test('without a context, a minimal context is built from the request and nothing is invented', async () => {
    const contextBuilderSpy = createSpyContextBuilder();
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderSpy });

    await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT);

    assert.equal(contextBuilderSpy.buildCalls.length, 1, 'exactly one minimal context must be built');
    const buildInput = contextBuilderSpy.buildCalls[0].options;
    assert.equal(buildInput.request, EXAMPLE_REQUEST);
    // No interaction metadata is invented by AIBrain: an unsupplied value is
    // forwarded as-is, and ContextBuilder's defaults are what render.
    assert.equal(buildInput.interactionContext, undefined);
    assert.equal(buildInput.intent, undefined);
    assert.equal(buildInput.emotionalSignal, undefined);
    assert.equal(buildInput.responseDepth, undefined);

    const prompt = adapter.generateCalls[0].prompt;
    assert.match(prompt, /ALICE Identity:/);
    assert.match(prompt, /Interaction Context:/);
    assert.match(prompt, /Emotional Response Guidance:/);
    assert.match(prompt, /Response Priority Contract:/);
    assert.match(prompt, /- Intent: unknown/, 'AIBrain must not fabricate an intent');
    assert.match(prompt, /- Broad contextual signal: neutral/, 'AIBrain must not fabricate a signal');
    assert.match(prompt, /- Personality mode: none/);
    assert.match(prompt, /- Response depth: quick/);
    assert.ok(prompt.includes(`User Request: "${EXAMPLE_REQUEST}"`));
});

test('a caller-supplied interactionContext is forwarded by reference when building', async () => {
    const contextBuilderStub = createRecordingContextBuilder();
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderStub });
    const interactionContext = { ...EXAMPLE_INTERACTION_CONTEXT };

    await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, null, { interactionContext });

    assert.equal(contextBuilderStub.buildCalls.length, 1);
    assert.strictEqual(
        contextBuilderStub.buildCalls[0].interactionContext,
        interactionContext,
        'the supplied metadata must be forwarded unchanged (ContextBuilder normalizes)'
    );
});

// ---------------------------------------------------------------------------
// 5) Adapter-options contract: interactionContext is never an adapter control
// ---------------------------------------------------------------------------

test('interactionContext is not forwarded as an adapter control option', async () => {
    const contextBuilderStub = createRecordingContextBuilder();
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderStub });
    const controller = new AbortController();
    const interactionContext = { ...EXAMPLE_INTERACTION_CONTEXT };

    await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, null, {
        interactionContext,
        timeout: 1234,
        signal: controller.signal,
        model: 'test-model',
        temperature: 0.2,
        maxOutputSize: 4321
    });

    const { options } = adapter.generateCalls[0];
    assert.equal('interactionContext' in options, false, 'prompt metadata must not become an adapter control');
    assert.equal(options.responseFormat, 'text', 'the synthesis step keeps the text response contract');
    assert.equal(options.timeout, 1234);
    assert.strictEqual(options.signal, controller.signal);
    // Every other adapter option still flows through unchanged.
    assert.equal(options.model, 'test-model');
    assert.equal(options.temperature, 0.2);
    assert.equal(options.maxOutputSize, 4321);
});

test('a supplied context is never overwritten by options.interactionContext', async () => {
    const contextBuilderStub = createRecordingContextBuilder();
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderStub });
    const builtInteractionContext = createInteractionContext(EXAMPLE_INTERACTION_CONTEXT);
    const context = { request: EXAMPLE_REQUEST, tools: [], interactionContext: builtInteractionContext, timestamp: 1 };

    await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, context, {
        interactionContext: { intent: 'action', responseDepth: 'quick' }
    });

    assert.equal(contextBuilderStub.buildCalls.length, 0);
    assert.strictEqual(context.interactionContext, builtInteractionContext);
    assert.equal(context.interactionContext.intent, 'information');
    assert.equal('interactionContext' in adapter.generateCalls[0].options, false);
});

// ---------------------------------------------------------------------------
// 6) Response-generation contract: natural language only, no hidden reasoning
// ---------------------------------------------------------------------------

test('the synthesis step has a presentation-only text contract, not the planning JSON contract', async () => {
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });
    const context = realContextBuilder.buildContext({
        request: EXAMPLE_REQUEST,
        interactionContext: createInteractionContext(EXAMPLE_INTERACTION_CONTEXT)
    });

    const response = await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, context);

    // The adapter's text is returned as the final user-facing response.
    assert.equal(response, 'Synthesized natural-language reply.');
    assert.equal(adapter.generateCalls[0].options.responseFormat, 'text');

    const prompt = adapter.generateCalls[0].prompt;
    assert.match(prompt, /Final Presentation-Only Response Contract:/);
    assert.match(prompt, /The task has already been executed/);
    assert.match(prompt, /Do not generate a plan, JSON, or tool calls\. Do not execute anything\./);
    assert.match(prompt, /Return only the natural-language user-facing answer/);
    assert.match(prompt, /original user request remains authoritative; the execution result is factual task output/i);
    assert.match(prompt, /ALICE Identity, Interaction Context, and Emotional Response Guidance influence communication style only/);
    assert.match(prompt, /Reply with the final user-facing natural-language response only/);
    assert.match(prompt, /no JSON, no plan, no Markdown code fences/);
    assert.match(prompt, /no internal reasoning or process narration/);
    assert.doesNotMatch(prompt, /Required JSON Output Contract|Return ONLY one JSON object/);
    assert.doesNotMatch(prompt, /\{"response":|\{"goal":/);
});

// ---------------------------------------------------------------------------
// 7) Fallbacks are preserved
// ---------------------------------------------------------------------------

test('synthesis failure falls back to the execution result response', async () => {
    const adapter = new RecordingAdapter();
    adapter.failure = new Error('Simulated synthesis outage');
    const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });
    const context = realContextBuilder.buildContext({ request: EXAMPLE_REQUEST });

    const response = await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, context);

    assert.equal(response, EXAMPLE_EXECUTION_RESULT.response);
});

test('synthesis failure without an execution result response uses the generic completion', async () => {
    const adapter = new RecordingAdapter();
    adapter.failure = new Error('Simulated synthesis outage');
    const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });

    const response = await brain.generateResponse(EXAMPLE_REQUEST, { skill: 'core', status: 'completed' });

    assert.equal(response, 'Task completed.');
});

test('an empty adapter response still yields the generic completion text', async () => {
    const adapter = new RecordingAdapter();
    adapter.nextResult = { text: '' };
    const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });

    const response = await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT);

    assert.equal(response, 'Task completed successfully.');
});

// ---------------------------------------------------------------------------
// 8) Timeout / AbortSignal / error handling is unchanged
// ---------------------------------------------------------------------------

test('a hanging synthesis still times out and falls back', async () => {
    const adapter = new MockAdapter();
    adapter.setHang(true);
    const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });
    const context = realContextBuilder.buildContext({ request: EXAMPLE_REQUEST });

    const started = Date.now();
    const response = await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, context, { timeout: 60 });
    const elapsed = Date.now() - started;

    assert.equal(response, EXAMPLE_EXECUTION_RESULT.response);
    assert.ok(elapsed < 3000, `synthesis must time out promptly (took ${elapsed}ms)`);
    adapter.reset();
});

test('an already-aborted signal still cancels synthesis and falls back', async () => {
    const adapter = new MockAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });
    const controller = new AbortController();
    controller.abort();
    const context = realContextBuilder.buildContext({ request: EXAMPLE_REQUEST });

    const response = await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, context, {
        signal: controller.signal
    });

    assert.equal(response, EXAMPLE_EXECUTION_RESULT.response);
    assert.equal(controller.signal.aborted, true, 'the caller signal must not be disturbed');
    assert.equal(typeof adapter.generate, 'function', 'the abort must be handled by the adapter, not swallowed by AIBrain');
});

test('adapter errors keep resolving through the documented fallbacks (no rejection)', async () => {
    const adapter = new RecordingAdapter();
    adapter.failure = Object.assign(new Error('boom'), { code: 'AI_PROVIDER' });
    const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });

    await assert.doesNotReject(async () => {
        const response = await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT);
        assert.equal(response, EXAMPLE_EXECUTION_RESULT.response);
    });
});

// ---------------------------------------------------------------------------
// 9) No network access and no new detection logic in AIBrain
// ---------------------------------------------------------------------------

test('context-aware synthesis introduces no network access', async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
        fetchCalls += 1;
        return Promise.reject(new Error(`Unexpected network access: ${String(args[0])}`));
    };

    try {
        const adapter = new RecordingAdapter();
        const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });
        const context = realContextBuilder.buildContext({ request: EXAMPLE_REQUEST });

        await brain.generateResponse(EXAMPLE_REQUEST, EXAMPLE_EXECUTION_RESULT, context, { timeout: 50 });
        await brain.generateResponse('What did you do?', { response: 'Summarized the research.' });

        assert.equal(fetchCalls, 0, 'synthesis must not perform network I/O');
        assert.equal(adapter.generateCalls.length, 2);
    } finally {
        if (originalFetch) globalThis.fetch = originalFetch;
        else delete globalThis.fetch;
    }
});

test('AIBrain still owns no detector, guidance, or identity logic of its own', async () => {
    const source = await readFile(new URL('../js/ai/aiBrain.js', import.meta.url), 'utf8');

    // No detectors, no persona/guidance tables, no ContextBuilder reimplementation.
    for (const forbidden of [
        './interactionContext.js',
        './intentDetector.js',
        './emotionalSignalDetector.js',
        './responseDepthDetector.js',
        './personalityModeDetector.js',
        './emotionalResponseGuidance.js',
        './aliceIdentity.js'
    ]) {
        assert.doesNotMatch(source, new RegExp(`from\\s*['"]\\./${forbidden.slice(2)}['"]`),
            `AIBrain must not import ${forbidden}`);
    }
    // The final synthesis path delegates formatting to the ContextBuilder.
    assert.match(source, /this\._contextBuilder\.formatForPrompt\(fullContext,\s*\{\s*responseContract: 'presentation'\s*\}\)/);
    assert.match(source, /this\._contextBuilder\.buildContext\(\{/);
    // interactionContext is prompt metadata, not an adapter option.
    assert.match(source, /const \{ interactionContext: _interactionContext, \.\.\.adapterOptions \} = options;/);
});
