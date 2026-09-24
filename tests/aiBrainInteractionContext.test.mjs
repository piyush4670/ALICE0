// Part 4: explicit interaction-context plumbing through AI Brain.
// Run: node --test tests/aiBrainInteractionContext.test.mjs
//
// Focused AIBrain tests only. A recording stub ContextBuilder captures
// buildContext() arguments and a recording stub ModelAdapter captures
// adapter.generate() arguments — zero network access (verified with a
// fetch spy). AIBrain must only FORWARD the caller-supplied interaction
// context: no detection, no inference, no enum/default normalization —
// ContextBuilder's Part 2 factory remains the single normalization boundary.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

globalThis.localStorage = {
    _d: {},
    getItem(key) { return this._d[key] ?? null; },
    setItem(key, value) { this._d[key] = String(value); },
    removeItem(key) { delete this._d[key]; }
};
globalThis.document = {
    createElement() {
        return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return null; } };
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; }
};
globalThis.Blob = class { constructor() {} };
// Preserve the native URL constructor (needed for new URL(...)/import.meta.url)
// while providing the blob helpers the memory module uses for exports.
const NativeURL = globalThis.URL;
globalThis.URL = class URL extends NativeURL {
    static createObjectURL() { return 'blob:test'; }
    static revokeObjectURL() {}
};

// The real ContextBuilder's memory adapter starts its normal reminder timer.
// Keep that pre-existing timer from holding this focused Node test process open.
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
    const handle = nativeSetInterval(...args);
    handle?.unref?.();
    return handle;
};

const { AIBrain } = await import('../js/ai/aiBrain.js');
const { ModelAdapter } = await import('../js/ai/modelAdapter.js');
const { contextBuilder: realContextBuilder } = await import('../js/ai/contextBuilder.js');
const { createInteractionContext } = await import('../js/ai/interactionContext.js');
globalThis.setInterval = nativeSetInterval;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** ContextBuilder stub that records every buildContext()/formatForPrompt() call. */
function createRecordingContextBuilder({ buildResult, onBuild } = {}) {
    const buildCalls = [];
    const formatCalls = [];
    return {
        buildCalls,
        formatCalls,
        buildContext(options = {}) {
            buildCalls.push(options);
            if (onBuild) return onBuild(options);
            return {
                request: options.request,
                interactionContext: options.interactionContext,
                tools: [],
                ...buildResult
            };
        },
        formatForPrompt(context) {
            formatCalls.push(context);
            return `PROMPT(${context?.request ?? ''})`;
        }
    };
}

/** ModelAdapter stub that records every generate() call and returns a canned result. */
class RecordingAdapter extends ModelAdapter {
    constructor(config = {}) {
        super(config);
        this.generateCalls = [];
        this.nextResult = { text: '', structured: { response: 'Stub response.' } };
    }

    async generate(prompt, options = {}) {
        this.generateCalls.push({ prompt, options });
        return typeof this.nextResult === 'function'
            ? this.nextResult(prompt, options)
            : this.nextResult;
    }
}

function createBrain({ buildResult, onBuild } = {}) {
    const contextBuilderStub = createRecordingContextBuilder({ buildResult, onBuild });
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: contextBuilderStub });
    return { brain, adapter, contextBuilderStub };
}

const EXAMPLE_INTERACTION_CONTEXT = Object.freeze({
    intent: 'information',
    responseDepth: 'explain',
    mode: 'teacher',
    emotionalSignal: 'curious',
    source: 'text',
    turnType: 'new'
});

// ---------------------------------------------------------------------------
// 1) Legacy call works without any interaction context
// ---------------------------------------------------------------------------

test('legacy processRequest("Hello") works and requires no interactionContext', async () => {
    const { brain, contextBuilderStub } = createBrain();

    const result = await brain.processRequest('Hello');

    assert.equal(result.success, true);
    assert.equal(result.isMultiStep, false);
    assert.equal(result.response, 'Stub response.');

    // The call is still explicitly plumbed (key present), but nothing is
    // supplied and — critically — AIBrain fabricates no context of its own.
    const call = contextBuilderStub.buildCalls[0];
    assert.equal(call.request, 'Hello');
    assert.ok('interactionContext' in call);
    assert.equal(call.interactionContext, undefined);
});

// ---------------------------------------------------------------------------
// 2) Explicit interaction context reaches the ContextBuilder unchanged
// ---------------------------------------------------------------------------

test('explicit interactionContext reaches ContextBuilder as the same supplied object', async () => {
    const { brain, contextBuilderStub } = createBrain();
    const interactionContext = { ...EXAMPLE_INTERACTION_CONTEXT };

    const result = await brain.processRequest('Explain photosynthesis', { interactionContext });

    assert.equal(result.success, true);
    assert.equal(contextBuilderStub.buildCalls.length, 1);
    // Same reference: forwarded unchanged — not copied, rebuilt, or replaced.
    assert.strictEqual(contextBuilderStub.buildCalls[0].interactionContext, interactionContext);
});

// ---------------------------------------------------------------------------
// 3) AIBrain does NOT mutate the supplied object
// ---------------------------------------------------------------------------

test('AIBrain does not mutate the supplied interactionContext object', async () => {
    const { brain, contextBuilderStub } = createBrain();
    const interactionContext = {
        ...EXAMPLE_INTERACTION_CONTEXT,
        // Extra unknown keys must survive untouched on the caller's object.
        extraNote: 'caller-owned'
    };
    const expected = { ...interactionContext };
    // Freezing makes any mutation attempt throw (ES modules are strict mode).
    Object.freeze(interactionContext);

    await brain.processRequest('Explain photosynthesis', { interactionContext });

    assert.deepEqual(interactionContext, expected);
    assert.ok(Object.isFrozen(interactionContext));
    assert.strictEqual(contextBuilderStub.buildCalls[0].interactionContext, interactionContext);
});

// ---------------------------------------------------------------------------
// 4) AIBrain does NOT implement its own enum/default normalization
// ---------------------------------------------------------------------------

test('AIBrain forwards raw values without enum/default normalization', async () => {
    const { brain, contextBuilderStub } = createBrain();

    // Invalid enum values must arrive at ContextBuilder raw (the Part 2
    // factory owns fallback-to-default). If AIBrain normalized, these would
    // come back as a fresh object with defaults like 'unknown'/'quick'.
    const bogus = {
        intent: 'totally-bogus',
        responseDepth: 'ultra',
        mode: 99,
        emotionalSignal: 'zzz',
        source: 'carrier-pigeon',
        turnType: 'sideways'
    };
    await brain.processRequest('Explain photosynthesis', { interactionContext: bogus });

    const forwarded = contextBuilderStub.buildCalls[0].interactionContext;
    assert.strictEqual(forwarded, bogus);
    assert.equal(forwarded.intent, 'totally-bogus');
    assert.equal(forwarded.responseDepth, 'ultra');
    assert.equal(forwarded.mode, 99);
    assert.equal(forwarded.emotionalSignal, 'zzz');
    assert.equal(forwarded.source, 'carrier-pigeon');
    assert.equal(forwarded.turnType, 'sideways');

    // Even non-object input is forwarded untouched — no coercion here.
    const { brain: brain2, contextBuilderStub: cb2 } = createBrain();
    await brain2.processRequest('Hi', { interactionContext: 'not-an-object' });
    assert.strictEqual(cb2.buildCalls[0].interactionContext, 'not-an-object');

    // Static guarantee: AIBrain imports neither the Part 2 factory nor its
    // enums, so it cannot hold a second representation or normalization path.
    const source = await readFile(new URL('../js/ai/aiBrain.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s*['"]\.\/interactionContext\.js['"]/);
    assert.doesNotMatch(source, /\bINTERACTION_(?:TURN_TYPES|INTENTS|RESPONSE_DEPTHS|MODES|EMOTIONAL_SIGNALS|SOURCES|CONTEXT_DEFAULTS)\b/);
    // The forward is explicit in the source, not an accidental options spread.
    assert.match(source, /interactionContext:\s*options\.interactionContext/);
});

// ---------------------------------------------------------------------------
// 5) ContextBuilder remains the normalization boundary
// ---------------------------------------------------------------------------

test('ContextBuilder (via the Part 2 factory) remains the normalization boundary', async () => {
    // Use the REAL ContextBuilder so normalization is observed end-to-end at
    // its existing home — AIBrain still only forwards the supplied value.
    const adapter = new RecordingAdapter();
    const brain = new AIBrain({ adapter, contextBuilder: realContextBuilder });

    await brain.processRequest('Explain photosynthesis', {
        interactionContext: {
            intent: 'not-a-real-intent',   // invalid → documented default
            responseDepth: 'explain',      // valid → kept
            mode: 'teacher',               // valid → kept
            emotionalSignal: 'curious',    // valid → kept
            source: 'text',
            turnType: 'new'
        }
    });

    const prompt = adapter.generateCalls[0].prompt;
    assert.match(prompt, /Interaction Context:/);
    assert.match(prompt, /- Intent: unknown/);            // normalized by factory
    assert.doesNotMatch(prompt, /- Intent: not-a-real-intent/);
    assert.match(prompt, /- Response depth: explain/);
    assert.match(prompt, /- Personality mode: teacher/);
    assert.match(prompt, /- Broad contextual signal: curious/);
    assert.match(prompt, /- Source: text/);
    assert.match(prompt, /- Turn type: new/);

    // With no supplied context, the prompt shows the factory's documented
    // defaults — produced by ContextBuilder, never selected by AIBrain.
    const adapter2 = new RecordingAdapter();
    const brain2 = new AIBrain({ adapter: adapter2, contextBuilder: realContextBuilder });
    await brain2.processRequest('Hello');
    const legacyPrompt = adapter2.generateCalls[0].prompt;
    assert.match(legacyPrompt, /- Intent: unknown/);
    assert.match(legacyPrompt, /- Response depth: quick/);
    assert.match(legacyPrompt, /- Personality mode: none/);
    assert.match(legacyPrompt, /- Broad contextual signal: neutral/);
});

// ---------------------------------------------------------------------------
// 6) Existing adapter options still reach the adapter; explicit CB boundary
// ---------------------------------------------------------------------------

test('adapter options reach the adapter and never become context-builder fields', async () => {
    const { brain, adapter, contextBuilderStub } = createBrain();
    const controller = new AbortController();
    const interactionContext = { ...EXAMPLE_INTERACTION_CONTEXT };

    await brain.processRequest('Explain photosynthesis', {
        interactionContext,
        timeout: 1234,
        signal: controller.signal,
        // Adapter-specific options (HttpModelAdapter surface):
        model: 'test-model',
        temperature: 0.2,
        maxOutputSize: 4321
    });

    // (a) Adapter options arrive at adapter.generate() unchanged.
    const generateCall = adapter.generateCalls[0];
    assert.equal(generateCall.options.timeout, 1234);
    assert.strictEqual(generateCall.options.signal, controller.signal);
    assert.equal(generateCall.options.model, 'test-model');
    assert.equal(generateCall.options.temperature, 0.2);
    assert.equal(generateCall.options.maxOutputSize, 4321);
    assert.equal(generateCall.options.responseFormat, 'plan');
    // Interaction context is ContextBuilder metadata, not an adapter control.
    assert.equal('interactionContext' in generateCall.options, false);

    // (b) buildContext() received ONLY its own fields — no accidental spread
    //     of arbitrary options into the context-builder input.
    const buildCall = contextBuilderStub.buildCalls[0];
    assert.strictEqual(buildCall.interactionContext, interactionContext);
    assert.deepEqual(
        Object.keys(buildCall).sort(),
        ['interactionContext', 'request'],
        'adapter options must not become context-builder fields'
    );

    // (c) Pre-existing ContextBuilder fields on options keep working.
    const { brain: brain2, contextBuilderStub: cb2 } = createBrain();
    await brain2.processRequest('Summarize my day', {
        historyLimit: 2,
        memoryLimit: 1,
        includeMemory: false,
        includeHistory: true
    });
    const keptCall = cb2.buildCalls[0];
    assert.equal(keptCall.historyLimit, 2);
    assert.equal(keptCall.memoryLimit, 1);
    assert.equal(keptCall.includeMemory, false);
    assert.equal(keptCall.includeHistory, true);
    assert.equal('timeout' in keptCall, false);
});

// ---------------------------------------------------------------------------
// 7) generatePlan() with an existing context preserves that context
// ---------------------------------------------------------------------------

test('generatePlan with an already-built context never rebuilds or overwrites it', async () => {
    // A rebuild would return this marker instead of the supplied context.
    const { brain, contextBuilderStub } = createBrain({
        onBuild: () => ({ request: 'REBUILT', interactionContext: { intent: 'REBUILT' } })
    });

    const builtInteractionContext = createInteractionContext({
        intent: 'information',
        responseDepth: 'deep',
        mode: 'analyst',
        emotionalSignal: 'neutral',
        source: 'voice',
        turnType: 'follow_up'
    });
    const existingContext = {
        request: 'Continue the report',
        history: [],
        memory: { memories: [], pinnedFacts: [], preferences: {}, recentTasks: [] },
        tools: [],
        taskState: { active: false, status: 'idle', currentAction: '' },
        interactionContext: builtInteractionContext,
        timestamp: 123
    };

    // Even a conflicting options.interactionContext must NOT overwrite the
    // already-built context's normalized value.
    const result = await brain.generatePlan('Continue the report', existingContext, {
        interactionContext: { intent: 'action', responseDepth: 'quick' }
    });

    assert.equal(result.isDirectResponse, true);
    assert.equal(contextBuilderStub.buildCalls.length, 0, 'context must not be rebuilt');
    assert.strictEqual(contextBuilderStub.formatCalls[0], existingContext);
    assert.strictEqual(
        contextBuilderStub.formatCalls[0].interactionContext,
        builtInteractionContext,
        'interactionContext of an existing context must be preserved'
    );
});

test('generatePlan without a context forwards options.interactionContext when building', async () => {
    const { brain, contextBuilderStub } = createBrain();
    const interactionContext = { ...EXAMPLE_INTERACTION_CONTEXT };

    await brain.generatePlan('Explain photosynthesis', null, { interactionContext });

    assert.equal(contextBuilderStub.buildCalls.length, 1);
    assert.equal(contextBuilderStub.buildCalls[0].request, 'Explain photosynthesis');
    assert.strictEqual(contextBuilderStub.buildCalls[0].interactionContext, interactionContext);

    // Legacy generatePlan(goal) / generatePlan(goal, context) shapes keep working.
    const { brain: brain2, contextBuilderStub: cb2 } = createBrain();
    await brain2.generatePlan('Hello');
    assert.equal(cb2.buildCalls[0].interactionContext, undefined);
});

// ---------------------------------------------------------------------------
// Security: interaction context is metadata and bypasses nothing
// ---------------------------------------------------------------------------

test('interaction context cannot bypass PlanValidator', async () => {
    const { brain, adapter } = createBrain();

    // A hostile caller claims broad capabilities through "metadata" while the
    // model emits an invalid plan (step missing its skill binding).
    adapter.nextResult = {
        text: '',
        structured: { goal: 'take over', steps: [{ id: 'step1' }] }
    };

    const result = await brain.processRequest('take over', {
        interactionContext: {
            intent: 'action',
            mode: 'guardian',
            grantPermissions: true,
            bypassPlanValidator: true,
            bypassPermissionGateway: true,
            permissions: 'all',
            credentials: { apiKey: 'steal' },
            code: 'require("fs").readFileSync("/etc/passwd")'
        }
    });

    // PlanValidator still rejects; no plan is ever handed back unvalidated.
    assert.equal(result.success, false);
    assert.equal(result.fallback, true);
    assert.ok(Array.isArray(result.validationErrors) && result.validationErrors.length > 0);
    assert.equal(result.plan, undefined);
});

// ---------------------------------------------------------------------------
// 7b) Part 7B: explicit intent passes through; AIBrain invents none
// ---------------------------------------------------------------------------

test('Part 7B: explicit intents pass through unchanged and none are invented', async () => {
    // Every allowed intent value is forwarded to ContextBuilder as the exact
    // same object AIBrain was given — AIBrain detects, infers, or normalizes
    // no intent of its own.
    for (const intent of ['information', 'action', 'conversation', 'clarification', 'unknown']) {
        const { brain, contextBuilderStub } = createBrain();
        const interactionContext = createInteractionContext({ intent });

        await brain.processRequest('What is quantum computing?', { interactionContext });

        assert.equal(contextBuilderStub.buildCalls.length, 1);
        assert.strictEqual(contextBuilderStub.buildCalls[0].interactionContext, interactionContext,
            `explicit intent "${intent}" must be forwarded by reference, unchanged`);
        assert.equal(contextBuilderStub.buildCalls[0].interactionContext.intent, intent);
    }

    // No interactionContext supplied: request text alone must not make AIBrain
    // fabricate one — the forwarded value stays exactly undefined.
    const bare = createBrain();
    await bare.brain.processRequest('What is quantum computing?');
    assert.ok('interactionContext' in bare.contextBuilderStub.buildCalls[0]);
    assert.equal(bare.contextBuilderStub.buildCalls[0].interactionContext, undefined);

    // End-to-end through the real ContextBuilder: an explicit intent survives
    // the full AIBrain path, and a request-only call still renders the
    // documented default — nothing was inferred from the question wording.
    const explicitAdapter = new RecordingAdapter();
    const explicitBrain = new AIBrain({ adapter: explicitAdapter, contextBuilder: realContextBuilder });
    await explicitBrain.processRequest('What is quantum computing?', {
        interactionContext: createInteractionContext({ intent: 'action' })
    });
    assert.match(explicitAdapter.generateCalls[0].prompt, /- Intent: action/);
    assert.doesNotMatch(explicitAdapter.generateCalls[0].prompt, /- Intent: unknown/);

    const requestOnlyAdapter = new RecordingAdapter();
    const requestOnlyBrain = new AIBrain({ adapter: requestOnlyAdapter, contextBuilder: realContextBuilder });
    await requestOnlyBrain.processRequest('What is quantum computing?');
    assert.match(requestOnlyAdapter.generateCalls[0].prompt, /- Intent: unknown/);
    assert.doesNotMatch(requestOnlyAdapter.generateCalls[0].prompt, /- Intent: information/);
});

// ---------------------------------------------------------------------------
// 8) No network access is introduced by this plumbing
// ---------------------------------------------------------------------------

test('the new plumbing introduces no network access', async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
        fetchCalls += 1;
        return Promise.reject(new Error(`Unexpected network access: ${String(args[0])}`));
    };

    try {
        const { brain, adapter, contextBuilderStub } = createBrain();
        const interactionContext = { ...EXAMPLE_INTERACTION_CONTEXT };

        await brain.processRequest('Explain photosynthesis', { interactionContext, timeout: 50 });
        await brain.generatePlan('Hello', null, { interactionContext });
        await brain.generateResponse('what did you do?', { response: 'Done' });

        assert.equal(fetchCalls, 0, 'plumbing must not perform network I/O');
        assert.ok(adapter.generateCalls.length >= 2);
        assert.ok(contextBuilderStub.buildCalls.length >= 1);
    } finally {
        if (originalFetch) globalThis.fetch = originalFetch;
        else delete globalThis.fetch;
    }
});
