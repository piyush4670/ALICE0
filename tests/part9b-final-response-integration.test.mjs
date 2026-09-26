// Part 9B correction — final response synthesis on the REAL Agent completion path.
// Run: node --test tests/part9b-final-response-integration.test.mjs
//
// Drives the production flow end to end:
//
//     conversation._processWithSkills()
//         → AIBrain.processRequest()      (real: ContextBuilder + detectors)
//         → PlanValidator                 (real)
//         → Agent.executePlan()           (real: Permission Gateway + skills)
//         → AIBrain.generateResponse()    (real, context-aware — PR #34)
//         → the single user-facing response
//
// Only the model boundary is faked (ScriptedAdapter / MockAdapter): zero
// network access, no Groq or provider credentials. No detector, skill,
// agent, permission, or ContextBuilder rule is reimplemented here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

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
const { state } = await import('../js/state.js');
const { memory } = await import('../js/memory.js');
const { CONFIG } = await import('../js/config.js');
const { ModelAdapter } = await import('../js/ai/modelAdapter.js');
const { contextBuilder } = await import('../js/ai/contextBuilder.js');
const { detectIntent } = await import('../js/ai/intentDetector.js');
const { detectResponseDepth } = await import('../js/ai/responseDepthDetector.js');
const { detectPersonalityMode } = await import('../js/ai/personalityModeDetector.js');
const { detectEmotionalSignal } = await import('../js/ai/emotionalSignalDetector.js');
const { getEmotionalResponseGuidance } = await import('../js/ai/emotionalResponseGuidance.js');
globalThis.setInterval = nativeSetInterval;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Fake model adapter with a scripted boundary:
 *   - the planning call (responseFormat 'plan') returns the configured plan
 *     (or a direct response),
 *   - the synthesis call (responseFormat 'text') returns / throws whatever the
 *     test asks for.
 * Records every call so the tests can inspect the real prompts.
 */
class ScriptedAdapter extends ModelAdapter {
    constructor({ plan = null, directResponse = null, synthesisText = 'Synthesized final response.', synthesisError = null } = {}) {
        super({});
        this._plan = plan;
        this._directResponse = directResponse;
        this._synthesisText = synthesisText;
        this._synthesisError = synthesisError;
        this.calls = [];
    }

    async generate(prompt, options = {}) {
        this.calls.push({ prompt, options });
        if (options.responseFormat === 'text') {
            if (this._synthesisError) throw this._synthesisError;
            return { text: this._synthesisText };
        }
        if (this._plan) {
            return { text: JSON.stringify(this._plan), structured: this._plan };
        }
        const structured = { response: this._directResponse };
        return { text: JSON.stringify(structured), structured };
    }
}

/**
 * Call-through spy; restores the original method (or removes the spy).
 * Async methods report their resolved value, so captured results are the real
 * return values rather than pending promises.
 */
function observe(target, method, onCall) {
    const owned = Object.hasOwn(target, method);
    const original = target[method];
    target[method] = function spy(...args) {
        const value = original.apply(this, args);
        if (value && typeof value.then === 'function') {
            return value.then(resolved => {
                onCall(args, resolved);
                return resolved;
            });
        }
        onCall(args, value);
        return value;
    };
    return () => {
        if (owned) target[method] = original;
        else delete target[method];
    };
}

const CALC_REQUEST = 'Calculate 25 percent of 800.';
const CALC_PLAN = {
    goal: CALC_REQUEST,
    steps: [{
        id: 'step_1',
        label: 'Calculate 25 percent of 800',
        skill: 'calculator',
        input: '25 percent of 800',
        contextKey: 'step_1',
        risk: 'safe'
    }]
};

/**
 * Run one request through the real conversation path with a scripted model
 * boundary, capturing the AI Brain plumbing. Every spy is restored.
 */
async function runRequest(request, {
    adapter = new ScriptedAdapter({ directResponse: 'Direct answer.' }),
    agentOverride = null,
    callCommand = false,
    prepare = null
} = {}) {
    const previousAdapter = aiBrain.getAdapter();
    const brainCalls = [];
    const synthesisCalls = [];
    const builtContexts = [];
    const spoken = [];
    const agentResults = [];
    const originalExecutePlan = agent.executePlan;
    if (agentOverride) agent.executePlan = agentOverride;
    const restore = [
        observe(aiBrain, 'processRequest', (args, value) => brainCalls.push({ args, value })),
        observe(aiBrain, 'generateResponse', (args, value) => synthesisCalls.push({ args, value })),
        observe(contextBuilder, 'buildContext', (args, value) => builtContexts.push({ args, value })),
        observe(agent, 'executePlan', (args, value) => agentResults.push(value)),
        observe(conversation, '_speakResponse', (args) => spoken.push(args[0]))
    ];
    aiBrain.setAdapter(adapter);
    conversation.clearHistory();
    state.clearConversation();
    state.resetTask();
    if (prepare) prepare();

    try {
        const result = callCommand
            ? await conversation._processCommand(request, 'text')
            : await conversation._processWithSkills(request, null, 'text');
        return {
            result,
            adapter,
            spoken,
            brainCalls,
            synthesisCalls,
            builtContexts,
            agentResults
        };
    } finally {
        // Undo the spies first: the executePlan spy was installed on top of a
        // test override, so its undo restores that override and the explicit
        // restore below must run last to put the real method back.
        for (const undo of restore.reverse()) undo();
        if (agentOverride) agent.executePlan = originalExecutePlan;
        aiBrain.setAdapter(previousAdapter);
    }
}

/** The `\n\n`-delimited prompt block that starts with `heading`. */
function blockOf(text, heading) {
    return text.split('\n\n').find(block => block.startsWith(heading));
}

// ---------------------------------------------------------------------------
// A. Direct AI response path is preserved (no extra synthesis call)
// ---------------------------------------------------------------------------

test('A. a direct AI response is returned as-is and never re-synthesized', async () => {
    const adapter = new ScriptedAdapter({ directResponse: 'Photosynthesis is how plants make food from light.' });

    const run = await runRequest('Explain photosynthesis.', { adapter });

    assert.deepEqual(run.result, {
        response: 'Photosynthesis is how plants make food from light.',
        skill: 'ai'
    });
    assert.equal(run.brainCalls.length, 1, 'the AI Brain planning step still runs once');
    assert.equal(run.synthesisCalls.length, 0, 'a direct AI response must not be re-synthesized');
    assert.equal(adapter.calls.length, 1, 'exactly one model call for a direct response');
    assert.equal(adapter.calls[0].options.responseFormat, 'plan');
});

// ---------------------------------------------------------------------------
// B + C. Multi-step success → exactly one context-aware synthesis call
// ---------------------------------------------------------------------------

test('B. a completed multi-step plan is synthesized exactly once with the planning context', async () => {
    const request = "I'm frustrated. Calculate 25 percent of 800.";
    const adapter = new ScriptedAdapter({
        plan: { ...CALC_PLAN, goal: request },
        synthesisText: 'I ran the calculation: 25% of 800 = 200.'
    });

    const run = await runRequest(request, { adapter });

    // The Agent really executed the validated plan (calculator skill).
    assert.equal(run.result.skill, 'agent');
    assert.equal(run.result.response, 'I ran the calculation: 25% of 800 = 200.');
    assert.equal(state.getTask().status, 'completed');

    // Exactly one planning call and one synthesis call.
    assert.equal(adapter.calls.length, 2);
    assert.equal(adapter.calls[0].options.responseFormat, 'plan');
    assert.equal(adapter.calls[1].options.responseFormat, 'text');

    // The synthesis received the original request, the factual execution
    // result and the SAME context the planning step built.
    assert.equal(run.synthesisCalls.length, 1, 'final synthesis must run exactly once');
    const [synthRequest, synthExecution, synthContext] = run.synthesisCalls[0].args;
    assert.equal(synthRequest, request, 'the original user request must be passed through');
    assert.equal(synthExecution.success, true);
    assert.match(String(synthExecution.response), /200/, 'the Agent execution result must be passed through');
    // Presentation payload only: no `context` field, no wrapper, no copy.
    assert.deepEqual(Object.keys(synthExecution).sort(), ['response', 'success']);
    assert.equal('context' in synthExecution, false);

    // AIBrain retained the context it built, and ConversationManager handed
    // that exact object back — no rebuild, no second context.
    assert.equal(run.brainCalls.length, 1);
    assert.equal(run.brainCalls[0].value.isMultiStep, true);
    assert.strictEqual(run.brainCalls[0].value.context, synthContext);
    assert.equal(run.builtContexts.length, 1, 'the ContextBuilder must build exactly one context');
    assert.strictEqual(run.builtContexts[0].value, synthContext);

    // The synthesis prompt reuses the same context under the presentation
    // contract and then adds the request + execution result.
    const planningPrompt = adapter.calls[0].prompt;
    const synthesisPrompt = adapter.calls[1].prompt;
    for (const heading of [
        'ALICE Identity:',
        'Interaction Context:',
        'Emotional Response Guidance:',
        'Response Priority Contract:',
        'Available Tools:',
        'User Request:'
    ]) {
        assert.equal(blockOf(synthesisPrompt, heading), blockOf(planningPrompt, heading),
            `${heading} must be carried into the synthesis prompt unchanged`);
    }
    assert.ok(synthesisPrompt.includes(`User Request: "${request}"`));
    assert.ok(synthesisPrompt.includes('Execution Result: '));
    assert.ok(
        synthesisPrompt.includes(JSON.stringify(synthExecution)),
        'the execution result must reach the model verbatim'
    );
    assert.ok(synthesisPrompt.length <= CONFIG.ai.gateway.maxPromptChars);
});

test('C. the synthesis prompt carries identity, interaction metadata, guidance and the priority contract', async () => {
    const request = "I'm frustrated. Calculate 25 percent of 800.";
    const adapter = new ScriptedAdapter({ plan: { ...CALC_PLAN, goal: request } });
    const before = fetchCalls;

    const run = await runRequest(request, { adapter });

    const prompt = adapter.calls[1].prompt;
    const [synthRequest, , synthContext] = run.synthesisCalls[0].args;

    // Identity
    assert.match(prompt, /ALICE Identity:/);
    assert.match(prompt, /- Name: ALICE\b/);

    // Interaction metadata: the same normalized metadata the request was
    // planned with — produced by the existing detectors, never re-detected here.
    const forwarded = run.brainCalls[0].args[1].interactionContext;
    assert.deepEqual(synthContext.interactionContext, forwarded);
    assert.strictEqual(synthContext.interactionContext,
        run.builtContexts[0].value.interactionContext,
        'the context carries its own normalized metadata unchanged');
    assert.equal(forwarded.turnType, 'new');
    assert.equal(forwarded.intent, detectIntent(request).intent);
    assert.equal(forwarded.responseDepth, detectResponseDepth(request).depth);
    assert.equal(forwarded.mode, detectPersonalityMode(request).mode);
    assert.equal(forwarded.emotionalSignal, detectEmotionalSignal(request).signal);
    assert.equal(forwarded.emotionalSignal, 'frustrated');
    assert.equal(forwarded.source, 'text');
    for (const line of [
        '- Turn type: new',
        `- Intent: ${forwarded.intent}`,
        `- Response depth: ${forwarded.responseDepth}`,
        `- Personality mode: ${forwarded.mode ?? 'none'}`,
        '- Broad contextual signal: frustrated',
        '- Source: text'
    ]) {
        assert.ok(prompt.includes(line), `missing interaction metadata in synthesis prompt: ${line}`);
    }

    // Emotional response guidance for that same signal
    const guidance = getEmotionalResponseGuidance('frustrated');
    assert.match(prompt, /Emotional Response Guidance:/);
    assert.ok(prompt.includes(`- Expressed signal: ${guidance.signal}`));
    assert.ok(prompt.includes(`- Communication tone: ${guidance.tone}`));

    // Response priority contract, presentation-only response contract, identity
    // section and tools context.
    assert.match(prompt, /Response Priority Contract:/);
    assert.ok(prompt.includes("The user's request is the primary task and must be answered or handled first."));
    assert.match(prompt, /Final Response Contract \(this step only\)/);
    assert.match(prompt, /Available Tools:/);
    assert.match(prompt, /ALICE Identity:/);

    // B. The machine-parsed planning instruction is NOT active in synthesis.
    assert.doesNotMatch(prompt, /Required JSON Output Contract/);
    assert.doesNotMatch(prompt, /Return ONLY one JSON object/);
    assert.doesNotMatch(prompt, /machine-parsed/);
    assert.ok(!prompt.includes('{"response": "your natural-language answer"}'));

    // A. The planning prompt of the very same request still carries it.
    assert.match(adapter.calls[0].prompt, /Required JSON Output Contract/);
    assert.ok(adapter.calls[0].prompt.includes('Return ONLY one JSON object. Nothing before it and nothing after it.'));

    // C. Synthesis is requested as plain text.
    assert.equal(adapter.calls[1].options.responseFormat, 'text');

    // The request stays authoritative in the synthesis instruction itself.
    assert.match(prompt, /The user's request is the primary task: answer it exactly as asked\./);
    assert.ok(synthRequest === request);
    assert.equal(fetchCalls, before);
});

test('C. no detector is re-run and no second interaction context is created', async () => {
    // Runtime: the synthesis receives the SAME context object that planning
    // built — its normalized metadata is the very object inside that context,
    // not a freshly normalized second one.
    const request = "I'm bored. Tell me one interesting fact.";
    const adapter = new ScriptedAdapter({ plan: { ...CALC_PLAN, goal: request } });
    const run = await runRequest(request, { adapter });

    const planningMetadata = run.brainCalls[0].args[1].interactionContext;
    const synthesisContext = run.synthesisCalls[0].args[2];
    assert.strictEqual(synthesisContext, run.brainCalls[0].value.context);
    assert.strictEqual(synthesisContext.interactionContext,
        run.builtContexts[0].value.interactionContext);
    assert.notStrictEqual(synthesisContext.interactionContext, planningMetadata,
        'the context holds ContextBuilder\'s single normalized copy of the supplied metadata');
    assert.deepEqual(synthesisContext.interactionContext, planningMetadata);
    assert.equal(Object.isFrozen(synthesisContext.interactionContext), true);
    assert.equal(run.builtContexts.length, 1, 'no second context is ever built');

    // Static: conversation.js still builds exactly one interaction context and
    // calls AIBrain exactly twice (plan once, synthesis once).
    const source = await readFile(new URL('../js/conversation.js', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(code.match(/createInteractionContext\s*\(/g).length, 1,
        'createInteractionContext() must remain the single context factory call');
    assert.equal(code.match(/aiBrain\.processRequest\s*\(/g).length, 1,
        'there must still be exactly one AI Brain request call');
    assert.equal(code.match(/aiBrain\.generateResponse\s*\(/g).length, 1,
        'there must be exactly one final synthesis call, in the helper');
    assert.match(code, /generateResponse\(request,\s*executionResult,\s*context\s*\|\|\s*null\)/);
    assert.match(code, /this\._synthesizeFinalResponse\(text,\s*agentResult,\s*aiResult\.context\)/);
    // No detector is invoked inside the synthesis helper.
    const helper = code.slice(code.indexOf('_synthesizeFinalResponse('), code.indexOf('_generateBasicResponse'));
    assert.doesNotMatch(helper, /detect(?:Intent|ResponseDepth|PersonalityMode|EmotionalSignal)\s*\(/);
    assert.doesNotMatch(helper, /createInteractionContext\s*\(/);
});

// ---------------------------------------------------------------------------
// E + F. The execution payload is the factual result only — no context copy
// ---------------------------------------------------------------------------

test('E. the execution payload never duplicates the ContextBuilder context', async () => {
    const pinned = memory.pinFact('The user prefers short answers.');
    const request = 'Calculate 25 percent of 800.';
    const adapter = new ScriptedAdapter({ plan: CALC_PLAN, synthesisText: 'That works out to 200.' });

    let run;
    try {
        run = await runRequest(request, {
            adapter,
            prepare: () => {
                state.addToConversation('user', 'Earlier: what is 10 percent of 200?');
                state.addToConversation('assistant', 'Earlier: 10% of 200 = 20.');
            }
        });
    } finally {
        memory.unpinFact(pinned.id);
    }

    const [, payload, context] = run.synthesisCalls[0].args;
    const payloadJson = JSON.stringify(payload);

    // Exactly the factual presentation fields.
    assert.deepEqual(Object.keys(payload).sort(), ['response', 'success']);
    assert.equal('context' in payload, false, 'no Agent blackboard may be embedded');
    assert.equal(fetchCalls, 0);

    // Nothing from the ContextBuilder context is copied into the payload.
    const contextJson = JSON.stringify(context);
    assert.notEqual(payloadJson, contextJson);
    for (const fragment of [
        'ALICE Identity', 'Interaction Context', 'Emotional Response Guidance',
        'Response Priority Contract', 'Required JSON Output Contract',
        'Available Tools', 'Conversation History', 'interactionContext', 'timestamp'
    ]) {
        assert.ok(!payloadJson.includes(fragment), `payload must not carry context data: ${fragment}`);
    }
    // The context is supplied separately (and exactly once).
    assert.strictEqual(context, run.brainCalls[0].value.context);
    assert.equal(run.builtContexts.length, 1, 'exactly one context is built and reused');
    assert.ok(Array.isArray(context.tools) && context.tools.length > 0, 'the real context is rich');
    assert.ok(context.interactionContext, 'the real context carries its interaction metadata');
    assert.ok(contextJson.includes('"interactionContext"'), 'the context data reaches synthesis separately');
    assert.ok(payloadJson.length < contextJson.length / 4, 'the payload stays a small factual result');

    // The Agent result object is untouched: its blackboard is still intact.
    const agentResult = run.agentResults[0];
    assert.ok(agentResult && agentResult.context && typeof agentResult.context === 'object',
        'the Agent result must keep its own context (never mutated)');
    assert.notStrictEqual(agentResult, payload, 'the payload is a new, minimal object');
    assert.equal(agentResult.response, payload.response);
    assert.equal(context, run.brainCalls[0].value.context);
});

test('F. the calculator fact stays authoritative in the synthesis prompt', async () => {
    const adapter = new ScriptedAdapter({ plan: CALC_PLAN, synthesisText: '25% of 800 is 200.' });
    const run = await runRequest(CALC_REQUEST, { adapter });

    const prompt = adapter.calls[1].prompt;
    const [, payload] = run.synthesisCalls[0].args;

    // The real skill result, exactly as the skill produced it.
    assert.ok(prompt.includes('25% of 800 = 200'), 'the calculator fact must reach the model');
    assert.equal(payload.response, '25% of 800 = 200.');
    assert.equal(run.result.response, '25% of 800 is 200.');
    assert.equal(state.getTask().status, 'completed');
    assert.equal(state.getTask().progress, 100);
});

test('G. the synthesis prompt stays bounded with realistic tools, history and memory', async () => {
    const pinned = memory.pinFact('The user is working on a quantum computing report.');
    memory.remember('quantum report deadline', 'The quantum report deadline is Friday');
    const adapter = new ScriptedAdapter({
        plan: {
            goal: 'Research quantum computing, summarize the findings and create a document.',
            steps: [{ id: 'step_1', label: 'Calculate 25 percent of 800', skill: 'calculator', input: '25 percent of 800', contextKey: 'step_1', risk: 'safe' }]
        },
        synthesisText: 'Done — the calculation is complete.'
    });

    const history = [];
    for (let i = 0; i < 6; i++) {
        history.push(['user', `Earlier user turn ${i + 1}: tell me about quantum computing, part ${i + 1}.`]);
        history.push(['assistant', `Earlier ALICE turn ${i + 1}: here is what I found about quantum computing, part ${i + 1}.`]);
    }

    let run;
    try {
        run = await runRequest('Research quantum computing, summarize the findings and create a document.', {
            adapter,
            prepare: () => {
                state.setTask({ active: true, status: 'running', currentAction: 'Gathering sources', progress: 40 });
                for (const [role, text] of history) state.addToConversation(role, text);
            }
        });
    } finally {
        memory.unpinFact(pinned.id);
        memory.forget('quantum report deadline');
        state.resetTask();
    }

    const prompt = adapter.calls[1].prompt;
    // The realistic sections are really present (this is the bounded prompt).
    assert.match(prompt, /Available Tools:/);
    assert.match(prompt, /Conversation History:/);
    assert.match(prompt, /ALICE: Earlier ALICE turn 6/);
    assert.ok(run.builtContexts[0].value.memory.pinnedFacts.length >= 1);
    assert.ok(prompt.length <= CONFIG.ai.gateway.maxPromptChars,
        `synthesis prompt is ${prompt.length} chars; the adapter limit is ${CONFIG.ai.gateway.maxPromptChars}`);
    // ...and it is still smaller than the planning prompt it replaces.
    assert.ok(prompt.length < adapter.calls[0].prompt.length,
        'the presentation contract must not grow the prompt');
    assert.equal(fetchCalls, 0);
});

// ---------------------------------------------------------------------------
// D + E. Failure and cancellation keep the Agent's own outcome
// ---------------------------------------------------------------------------

test('D. a failed agent execution keeps its own response and never synthesizes', async () => {
    const failureResponse = 'I had to stop. Research the topic could not be completed: network down.';
    const adapter = new ScriptedAdapter({ plan: CALC_PLAN });

    const run = await runRequest(CALC_REQUEST, {
        adapter,
        agentOverride: async () => ({ response: failureResponse, success: false })
    });

    assert.equal(run.result.skill, 'agent');
    assert.equal(run.result.response, failureResponse, 'the Agent failure response must remain intact');
    assert.equal(run.synthesisCalls.length, 0, 'a failed task must never be synthesized as success');
    assert.equal(adapter.calls.length, 1, 'no synthesis model call may happen after a failure');
});

test('E. a cancelled task keeps its cancellation response and never synthesizes', async () => {
    // Real path: the Permission Gateway asks for confirmation on a gated step
    // and the user denies it, so the Agent cancels the task.
    memory.addNote('Cancellation sentinel', 'must survive the denied plan');
    const plan = {
        goal: 'delete note 1',
        steps: [{ id: 'step_1', label: 'Delete note 1', skill: 'notes', input: 'delete note 1', risk: 'safe' }]
    };
    const adapter = new ScriptedAdapter({ plan });
    let promptFired = false;
    permissions.onPrompt(() => {
        promptFired = true;
        setTimeout(() => permissions.answer(false), 0);   // user DENIES
    });

    let run;
    try {
        run = await runRequest('delete note 1', { adapter });
    } finally {
        permissions.onPrompt(null);
    }

    assert.equal(promptFired, true, 'the gated step must still prompt through the Permission Gateway');
    assert.equal(run.result.skill, 'agent');
    assert.match(run.result.response, /cancel/i, 'the Agent cancellation response must be preserved');
    assert.equal(run.synthesisCalls.length, 0, 'a cancelled task must never run final synthesis');
    assert.equal(adapter.calls.length, 1, 'no synthesis model call may happen after a cancellation');
    assert.equal(memory.getNotes().some(n => n.title === 'Cancellation sentinel'), true,
        'the denied plan must not have changed state');
});

test('E. an agent-level cancelled result (success: false) is never synthesized', async () => {
    const cancelResponse = 'Understood — task cancelled. Nothing was changed.';
    const adapter = new ScriptedAdapter({ plan: CALC_PLAN });

    const run = await runRequest(CALC_REQUEST, {
        adapter,
        agentOverride: async () => ({ response: cancelResponse, success: false })
    });

    assert.equal(run.result.response, cancelResponse);
    assert.equal(run.synthesisCalls.length, 0);
});

// ---------------------------------------------------------------------------
// F. Synthesis failure falls back to the Agent execution response
// ---------------------------------------------------------------------------

test('F. a synthesis failure falls back to the agent execution response', async () => {
    const adapter = new ScriptedAdapter({
        plan: CALC_PLAN,
        synthesisError: new Error('Simulated synthesis outage')
    });

    const before = fetchCalls;
    const run = await runRequest(CALC_REQUEST, { adapter });

    assert.equal(run.result.skill, 'agent');
    assert.equal(run.synthesisCalls.length, 1, 'synthesis is attempted once');
    assert.equal(typeof run.synthesisCalls[0].value, 'string');
    assert.match(run.result.response, /200/, 'the Agent execution response must be the fallback');
    assert.notEqual(run.result.response, 'Synthesized final response.');
    assert.equal(state.getTask().status, 'completed');
    assert.equal(fetchCalls, before);
});

test('F. a synthesis that returns no text still yields a safe, non-empty reply', async () => {
    const adapter = new ScriptedAdapter({ plan: CALC_PLAN, synthesisText: '' });

    const run = await runRequest(CALC_REQUEST, { adapter });

    assert.equal(typeof run.result.response, 'string');
    assert.ok(run.result.response.trim().length > 0, 'the user must never receive an empty response');
    assert.equal(run.result.response, 'Task completed successfully.');
});

// ---------------------------------------------------------------------------
// G. Exactly one final response reaches the user
// ---------------------------------------------------------------------------

test('G. exactly one final response is spoken for a completed multi-step task', async () => {
    const request = 'Calculate 25 percent of 800.';
    const synthesized = '25 percent of 800 is 200.';
    const adapter = new ScriptedAdapter({ plan: CALC_PLAN, synthesisText: synthesized });

    const run = await runRequest(request, { adapter, callCommand: true });

    const finalResponses = run.spoken.filter(text => text === synthesized);
    assert.equal(finalResponses.length, 1, 'the synthesized response must be spoken exactly once');
    assert.equal(run.spoken.some(text => /^Done\./.test(text)), false,
        'the Agent completion text must not also be spoken as a separate final answer');
    assert.equal(run.spoken.length, 1, 'a single-step plan has no progress announcements');

    // Exactly one final answer in the AI Brain pipeline and one in the
    // conversation history (recorded by _speakResponse).
    assert.equal(run.synthesisCalls.length, 1);
    assert.equal(adapter.calls.length, 2);
    const aliceEntries = state.getConversation().filter(entry => entry.role === 'alice');
    assert.deepEqual(aliceEntries.map(entry => entry.text), [synthesized]);
    assert.equal(state.getVoiceState().lastAliceResponse, synthesized);
});

test('G. multi-step progress announcements are preserved, with one synthesized completion', async () => {
    const twoStepPlan = {
        goal: 'Calculate two sums',
        steps: [
            { id: 'step_1', label: 'Add two and two', skill: 'calculator', input: '2 plus 2', contextKey: 'step_1', risk: 'safe' },
            { id: 'step_2', label: 'Add three and three', skill: 'calculator', input: '3 plus 3', contextKey: 'step_2', risk: 'safe' }
        ]
    };
    const synthesized = 'Both sums are done: 4 and 6.';
    const adapter = new ScriptedAdapter({ plan: twoStepPlan, synthesisText: synthesized });

    const run = await runRequest('Calculate two sums and then add three and three.', {
        adapter,
        callCommand: true
    });

    // Existing progress announcements are unchanged...
    assert.ok(run.spoken.some(text => /^I'll handle this in 2 steps/.test(text)), 'plan announcement preserved');
    assert.ok(run.spoken.some(text => /— done\.$/.test(text)), 'step announcements preserved');
    // ...and the completion is synthesized exactly once, never the raw report.
    assert.equal(run.spoken.filter(text => text === synthesized).length, 1);
    assert.equal(run.spoken.filter(text => /^Done\. I completed:/.test(text)).length, 0);
    assert.equal(run.synthesisCalls.length, 1);
    assert.equal(state.getTask().status, 'completed');
});

// ---------------------------------------------------------------------------
// I. Existing behaviour intact
// ---------------------------------------------------------------------------

test('I. calculator facts stay authoritative and the AI-disabled path is unchanged', async () => {
    const request = 'Calculate 25 percent of 800.';
    const adapter = new ScriptedAdapter({
        plan: CALC_PLAN,
        synthesisText: 'Sure — 25 percent of 800 works out to 200.'
    });
    const run = await runRequest(request, { adapter });

    // The skill's real result reaches the synthesis prompt; nothing is invented.
    const prompt = adapter.calls[1].prompt;
    assert.ok(prompt.includes('25% of 800 = 200'));
    assert.match(run.result.response, /200/);

    // A disabled AI Brain never enters the AI plan path, so the deterministic
    // Agent path is untouched and no synthesis is attempted.
    const disabledAdapter = new ScriptedAdapter({ plan: CALC_PLAN });
    aiBrain.setEnabled(false);
    try {
        const disabledRun = await runRequest(request, { adapter: disabledAdapter });
        assert.ok(disabledRun.result && typeof disabledRun.result.response === 'string');
        assert.equal(disabledRun.synthesisCalls.length, 0, 'no synthesis without the AI plan path');
        assert.equal(disabledAdapter.calls.length, 0);
    } finally {
        aiBrain.setEnabled(true);
    }
});

test('H. the whole corrected path performs no network I/O', async () => {
    const before = fetchCalls;
    const adapter = new ScriptedAdapter({ plan: CALC_PLAN, synthesisText: 'All done.' });
    const run = await runRequest(CALC_REQUEST, { adapter, callCommand: true });

    assert.equal(fetchCalls, before, 'the corrected path must stay fully offline');
    assert.equal(run.synthesisCalls.length, 1);
    assert.equal(aiBrain.isEnabled(), true, 'this suite must not leave AI Brain disabled');
});
