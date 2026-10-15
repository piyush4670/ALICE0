// AI natural-language routing and categorized fallback outcomes.
// Run: node tests/aiNaturalLanguageRouting.test.mjs
//
// Deterministic by construction: scripted adapters, injected fetch doubles
// and an in-process gateway that forwards to a local stub upstream. No live
// network access, no real provider, no credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, beforeEach, describe, test } from 'node:test';

// Browser globals must exist before app modules are imported.
globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; } },
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
    AudioContext: undefined,
    webkitAudioContext: undefined
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: undefined, permissions: undefined }, configurable: true });
globalThis.document = {
    createElement() {
        return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return null; } };
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; }
};
globalThis.Blob = class { constructor() {} };
// Add blob helpers to the real URL class; never replace URL itself.
URL.createObjectURL ??= () => 'blob:test';
URL.revokeObjectURL ??= () => {};

// The app starts UI/metrics intervals at import time. Unref them so this
// test process exits when the suite finishes.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
    const handle = realSetInterval(...args);
    handle?.unref?.();
    return handle;
};

const { conversation } = await import('../js/conversation.js');
const { aiBrain } = await import('../js/ai/aiBrain.js');
const { ModelAdapter } = await import('../js/ai/modelAdapter.js');
const { MockAdapter } = await import('../js/ai/mockAdapter.js');
const { HttpModelAdapter } = await import('../js/ai/httpModelAdapter.js');
const { routeRequest, REQUEST_ROUTE } = await import('../js/ai/requestRouter.js');
const { AI_OUTCOME, fallbackResponseFor, formatAiDiagnostic, classifyAiError } = await import('../js/ai/aiOutcome.js');
const { skillManager } = await import('../js/skillManager.js');
const { permissions } = await import('../js/permissions.js');
const { agent } = await import('../js/agent.js');
const { state } = await import('../js/state.js');
const { createGatewayServer } = await import('../server/gateway.js');

let pass = 0;
let fail = 0;
void pass; void fail;

// ==================================================================
// Test doubles and helpers
// ==================================================================

/** Deterministic adapter: the handler scripts every generation. */
class ScriptedAdapter extends ModelAdapter {
    constructor(handler) {
        super({});
        this._handler = handler;
        this.calls = [];
    }

    async generate(prompt, options = {}) {
        this.calls.push({ prompt: String(prompt), options });
        return this._handler(String(prompt), options, this.calls.length);
    }
}

/** Live-looking model answer in the JSON direct-response form. */
function liveAnswer(answer) {
    return { text: JSON.stringify({ response: answer }), structured: { response: answer }, usage: null, offline: false };
}

/** Live structured plan. */
function livePlan(plan) {
    return { text: JSON.stringify(plan), structured: plan, usage: null, offline: false };
}

/** Plain-text answer used when a request is a synthesis (responseFormat text). */
function synthesisText(text) {
    return { text, structured: null, usage: null, offline: false };
}

/** Adapter-level timeout exactly as the shared transport produces it. */
function hangFor(adapter, options) {
    return adapter.withTimeout(new Promise(() => {}), options.timeout || 25);
}

function fakeResponse(status, rawBody) {
    return {
        status,
        headers: { get() { return null; } },
        text: async () => rawBody
    };
}

async function withAdapter(adapter, fn) {
    const previous = aiBrain.getAdapter();
    aiBrain.setAdapter(adapter);
    try {
        return await fn();
    } finally {
        aiBrain.setAdapter(previous);
    }
}

/**
 * Observe every point where an action could start: the agent, the single-skill
 * path, the skill body and the Permission Gateway. Calls still pass through.
 */
function observeExecution({ allowGate = true } = {}) {
    const seen = { executeByName: [], executePlan: [], agentProcess: [], gate: [], skillBody: [] };
    const originals = {
        executeByName: skillManager.executeByName,
        executeSkill: skillManager._executeSkill,
        gate: permissions.gate,
        executePlan: agent.executePlan,
        agentProcess: agent.process
    };

    skillManager.executeByName = async function (name, ...rest) {
        seen.executeByName.push(name);
        return originals.executeByName.call(this, name, ...rest);
    };
    skillManager._executeSkill = async function (skill, ...rest) {
        seen.skillBody.push(skill?.name);
        return originals.executeSkill.call(this, skill, ...rest);
    };
    permissions.gate = async function (skill, input, context) {
        seen.gate.push(skill?.name);
        if (!allowGate) {
            return { allowed: false, decision: 'denied', skill: skill?.name, reason: 'test denial', message: 'Denied for this test.' };
        }
        return originals.gate.call(this, skill, input, context);
    };
    agent.executePlan = async function (...args) {
        seen.executePlan.push(args[0]?.plan?.length ?? 0);
        return originals.executePlan.apply(this, args);
    };
    agent.process = async function (...args) {
        seen.agentProcess.push(String(args[0]));
        return originals.agentProcess.apply(this, args);
    };

    return {
        seen,
        restore() {
            skillManager.executeByName = originals.executeByName;
            skillManager._executeSkill = originals.executeSkill;
            permissions.gate = originals.gate;
            agent.executePlan = originals.executePlan;
            agent.process = originals.agentProcess;
        }
    };
}

function activityMessages() {
    return state.get('activityLog').map((entry) => String(entry.message));
}

// Generic replies that existed before this change. None may be returned when
// a valid natural-language answer was produced, and none may be returned as a
// model-failure recovery.
const LEGACY_GENERIC_REPLIES = [
    /That's interesting! I'm not sure how to help/,
    /I'm here to help you with calculations/,
    /I'm here to help! Try asking me to calculate/,
    /I understood your request/,
    /I have processed your request/,
    /Understood: /
];

// ==================================================================
// 1. Routing decision
// ==================================================================

describe('routing: ordinary requests vs action requests', () => {
    test('unknown general questions and conversation take the conversational route', () => {
        assert.equal(routeRequest('Is Paris the capital of France?'), REQUEST_ROUTE.CONVERSATION);
        assert.equal(routeRequest('Write a short poem about the sea.'), REQUEST_ROUTE.CONVERSATION);
        assert.equal(routeRequest('What did I just ask you?'), REQUEST_ROUTE.CONVERSATION);
        assert.equal(routeRequest('Can you explain that again?'), REQUEST_ROUTE.CONVERSATION);
        assert.equal(routeRequest(''), REQUEST_ROUTE.CONVERSATION);
    });

    test('explicit action requests take the action route', () => {
        assert.equal(routeRequest('Remind me to call mom at 6 PM'), REQUEST_ROUTE.ACTION);
        assert.equal(routeRequest('Calculate 25 percent of 800'), REQUEST_ROUTE.ACTION);
        assert.equal(routeRequest('research quantum computing, summarize the important information and create a document'), REQUEST_ROUTE.ACTION);
    });

    test('the router is a pure function of injected signals', () => {
        const skillHit = { skillManager: { matchSkill: () => ({ skill: { name: 'calculator' } }) }, taskPlanner: { analyze: () => ({ isMultiStep: false }) } };
        const plannerHit = { skillManager: { matchSkill: () => ({ skill: null }) }, taskPlanner: { analyze: () => ({ isMultiStep: true }) } };
        const none = { skillManager: { matchSkill: () => ({ skill: null }) }, taskPlanner: { analyze: () => ({ isMultiStep: false }) } };
        const throwing = { skillManager: { matchSkill: () => { throw new Error('boom'); } }, taskPlanner: { analyze: () => { throw new Error('boom'); } } };

        assert.equal(routeRequest('anything here', skillHit), REQUEST_ROUTE.ACTION);
        assert.equal(routeRequest('anything here', plannerHit), REQUEST_ROUTE.ACTION);
        assert.equal(routeRequest('anything here', none), REQUEST_ROUTE.CONVERSATION);
        assert.equal(routeRequest('anything here', throwing), REQUEST_ROUTE.CONVERSATION, 'a routing fault is never an action');
    });
});

// ==================================================================
// 2. Unknown general question -> natural-language answer
// ==================================================================

describe('unknown general question receives a natural-language answer', () => {
    beforeEach(() => { state.clearConversation(); conversation._hasHadInteraction = false; });

    test('the model answer is returned through the conversational path, not a canned reply', async () => {
        const adapter = new ScriptedAdapter(() => liveAnswer('Yes, Paris is the capital of France.'));
        const spies = observeExecution();
        try {
            const result = await withAdapter(adapter, () => conversation._processWithSkills('Is Paris the capital of France?'));

            assert.equal(result.skill, 'ai');
            assert.equal(result.response, 'Yes, Paris is the capital of France.');
            assert.equal(adapter.calls.length, 1, 'exactly one model call for an ordinary question');
            assert.match(adapter.calls[0].prompt, /Is Paris the capital of France\?/);
            assert.match(adapter.calls[0].prompt, /Required JSON Output Contract/);
            assert.equal(adapter.calls[0].options.responseFormat, 'plan');
        } finally {
            spies.restore();
        }
    });

    test('a question a pattern skill also claims still receives the live direct answer', async () => {
        // Route signals are keyword-based, so some questions are claimed by a
        // lookup skill. A live direct answer must still be used for them.
        const adapter = new ScriptedAdapter(() => liveAnswer('The capital of Peru is Lima.'));
        const result = await withAdapter(adapter, () => conversation._processWithSkills('What is the capital of Peru?'));
        assert.equal(result.response, 'The capital of Peru is Lima.');
        assert.equal(result.skill, 'ai');
    });

    test('a creative request gets the model text verbatim, with no generic reply', async () => {
        const poem = 'Waves fold their silver hands over the sand.';
        const adapter = new ScriptedAdapter(() => liveAnswer(poem));
        const result = await withAdapter(adapter, () => conversation._processWithSkills('Write a short poem about the sea.'));

        assert.equal(result.response, poem);
        for (const pattern of LEGACY_GENERIC_REPLIES) {
            assert.doesNotMatch(result.response, pattern);
        }
    });
});

// ==================================================================
// 3. Direct conversational answers never enter action execution
// ==================================================================

describe('a direct conversational answer does not enter action execution', () => {
    beforeEach(() => { state.clearConversation(); conversation._hasHadInteraction = false; });

    test('no agent, skill body or permission gate runs, even when the answer mentions an action', async () => {
        const adapter = new ScriptedAdapter(() => liveAnswer('I can remind you about that tomorrow if you ask me to.'));
        const spies = observeExecution();
        try {
            const result = await withAdapter(adapter, () => conversation._processWithSkills('Is Paris the capital of France?'));

            assert.equal(result.skill, 'ai');
            assert.deepEqual(spies.seen.executeByName, []);
            assert.deepEqual(spies.seen.skillBody, []);
            assert.deepEqual(spies.seen.gate, []);
            assert.deepEqual(spies.seen.executePlan, []);
            assert.deepEqual(spies.seen.agentProcess, []);
        } finally {
            spies.restore();
        }
    });
});

// ==================================================================
// 4. Follow-up turns receive the prior conversation
// ==================================================================

describe('follow-up questions receive the relevant prior conversation', () => {
    beforeEach(() => { state.clearConversation(); conversation._hasHadInteraction = false; });

    test('the second turn prompt carries the first question and the first answer', async () => {
        const adapter = new ScriptedAdapter((prompt) => {
            if (/And what about its population\?/.test(prompt)) {
                return liveAnswer('Paris has roughly two million residents in the city proper.');
            }
            return liveAnswer('Yes, Paris is the capital of France.');
        });

        await withAdapter(adapter, async () => {
            await conversation._processCommand('Is Paris the capital of France?', 'text');
            await conversation._processCommand('And what about its population?', 'text');
        });

        assert.equal(adapter.calls.length, 2);
        const followUp = adapter.calls[1].prompt;
        assert.match(followUp, /Conversation History:/);
        assert.match(followUp, /User: Is Paris the capital of France\?/, 'prior user turn is included');
        assert.match(followUp, /ALICE: Yes, Paris is the capital of France\./, 'prior ALICE answer is included');
        assert.match(followUp, /User Request: "And what about its population\?"/);
        assert.equal((followUp.match(/And what about its population\?/g) || []).length, 1,
            'the current turn is supplied once, as the User Request');
        assert.equal(state.get('voice.lastAliceResponse'),
            'Paris has roughly two million residents in the city proper.');
    });
});

// ==================================================================
// 5. Valid action requests keep validation and the permission boundary
// ==================================================================

describe('valid action requests still pass validation and the permission boundary', () => {
    beforeEach(() => { state.clearConversation(); conversation._hasHadInteraction = false; });

    const calcPlan = {
        goal: 'Calculate 25 percent of 800',
        steps: [{ id: 'step_1', skill: 'calculator', input: '25 percent of 800' }]
    };

    test('an allowed valid plan executes through the gate and the skill, and reports its result', async () => {
        const adapter = new ScriptedAdapter((prompt, options) => (
            options.responseFormat === 'text' ? synthesisText('25 percent of 800 is 200.') : livePlan(calcPlan)
        ));
        const spies = observeExecution({ allowGate: true });
        try {
            const result = await withAdapter(adapter, () => conversation._processWithSkills('Calculate 25 percent of 800'));

            assert.equal(result.skill, 'agent');
            assert.deepEqual(spies.seen.gate, ['calculator'], 'the permission gate decided for the planned skill');
            assert.deepEqual(spies.seen.skillBody, ['calculator'], 'the skill ran only after an allow decision');
        } finally {
            spies.restore();
        }
    });

    test('a denied valid plan never reaches the skill body', async () => {
        const adapter = new ScriptedAdapter((prompt, options) => (
            options.responseFormat === 'text' ? synthesisText('unused') : livePlan(calcPlan)
        ));
        const spies = observeExecution({ allowGate: false });
        try {
            await withAdapter(adapter, () => conversation._processWithSkills('Calculate 25 percent of 800'));

            assert.ok(spies.seen.gate.includes('calculator'), 'the gate was consulted');
            assert.deepEqual(spies.seen.skillBody, [], 'no skill body ran after a denial');
        } finally {
            spies.restore();
        }
    });
});

// ==================================================================
// 6. Malformed structured output never executes an action
// ==================================================================

describe('malformed structured output does not execute an action', () => {
    beforeEach(() => { state.clearConversation(); conversation._hasHadInteraction = false; });

    test('a plan that names an unknown skill is rejected before execution (action request)', async () => {
        const adapter = new ScriptedAdapter(() => livePlan({
            goal: 'Calculate 25 percent of 800',
            steps: [{ id: 'step_1', skill: 'teleporter', input: 'everything' }]
        }));
        const spies = observeExecution();
        try {
            const result = await withAdapter(adapter, () => conversation._processWithSkills('Calculate 25 percent of 800'));

            assert.ok(!spies.seen.executeByName.includes('teleporter'), 'the invented skill is never executed');
            assert.ok(!spies.seen.skillBody.includes('teleporter'));
            // Action fallback still runs the deterministic calculator, never the model's plan.
            assert.deepEqual(spies.seen.skillBody, ['calculator']);
            assert.match(result.response, /200/);
        } finally {
            spies.restore();
        }
    });

    test('a structurally invalid plan on an ordinary question executes nothing and says why', async () => {
        const adapter = new ScriptedAdapter(() => livePlan({ steps: [{ id: 'x1' }] }));
        const spies = observeExecution();
        try {
            const result = await withAdapter(adapter, () => conversation._processWithSkills('Is Paris the capital of France?'));

            assert.deepEqual(spies.seen.executeByName, []);
            assert.deepEqual(spies.seen.executePlan, []);
            assert.equal(result.skill, 'fallback');
            assert.equal(result.response, fallbackResponseFor(AI_OUTCOME.INVALID_OUTPUT));
        } finally {
            spies.restore();
        }
    });

    test('non-JSON model text through the real HTTP adapter is an invalid output, not an answer', async () => {
        const adapter = new HttpModelAdapter({
            fetchImpl: async () => fakeResponse(200, JSON.stringify({ text: 'Sure! Paris is the capital.', usage: null, realProvider: true }))
        });
        const spies = observeExecution();
        try {
            const result = await withAdapter(adapter, () => conversation._processWithSkills('Is Paris the capital of France?'));

            assert.equal(result.skill, 'fallback');
            assert.equal(result.response, fallbackResponseFor(AI_OUTCOME.INVALID_OUTPUT));
            assert.deepEqual(spies.seen.executeByName, []);
        } finally {
            spies.restore();
        }
    });

    test('an empty model reply is a failure, never the old "Understood." success', async () => {
        const adapter = new ScriptedAdapter(() => ({ text: '   ', structured: null, usage: null, offline: false }));
        const result = await withAdapter(adapter, () => aiBrain.processRequest('Is Paris the capital of France?'));

        assert.equal(result.success, false);
        assert.equal(result.outcome, AI_OUTCOME.INVALID_OUTPUT);
        assert.doesNotMatch(String(result.response ?? ''), /Understood/);
    });
});

// ==================================================================
// 7. Provider failure, timeout and cancellation are distinct outcomes
// ==================================================================

describe('provider failure, timeout and cancellation produce distinct outcomes', () => {
    test('gateway unreachable -> provider_unavailable', async () => {
        const adapter = new HttpModelAdapter({
            fetchImpl: async () => { throw new TypeError('fetch failed'); }
        });
        const result = await withAdapter(adapter, () => aiBrain.processRequest('What is the capital of Peru?'));

        assert.equal(result.success, false);
        assert.equal(result.outcome, AI_OUTCOME.PROVIDER_UNAVAILABLE);
        assert.equal(result.code, 'AI_PROVIDER');
        assert.equal(result.stage, 'generate');
    });

    test('gateway HTTP 503 -> provider_unavailable (not timeout, not invalid output)', async () => {
        const adapter = new HttpModelAdapter({
            fetchImpl: async () => fakeResponse(503, JSON.stringify({ error: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'down' } }))
        });
        const result = await withAdapter(adapter, () => aiBrain.processRequest('What is the capital of Peru?'));

        assert.equal(result.outcome, AI_OUTCOME.PROVIDER_UNAVAILABLE);
        assert.equal(result.stage, 'generate');
    });

    test('a model that never answers -> timeout, reported as AI_TIMEOUT', async () => {
        const adapter = new HttpModelAdapter({
            fetchImpl: () => new Promise(() => {}) // never settles; the adapter must bound it
        });
        const result = await withAdapter(adapter, () => aiBrain.processRequest('What is the capital of Peru?', { timeout: 30 }));

        assert.equal(result.success, false);
        assert.equal(result.outcome, AI_OUTCOME.TIMEOUT);
        assert.equal(result.code, 'AI_TIMEOUT');
    });

    test('an in-flight request aborted by the caller -> cancelled, not timeout or provider', async () => {
        const controller = new AbortController();
        const adapter = new HttpModelAdapter({
            fetchImpl: (url, init) => new Promise((resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            })
        });
        const pending = withAdapter(adapter, () => aiBrain.processRequest('What is the capital of Peru?', {
            timeout: 5000,
            signal: controller.signal
        }));
        setTimeout(() => controller.abort(), 10);
        const result = await pending;

        assert.equal(result.outcome, AI_OUTCOME.CANCELLED);
        assert.equal(result.code, 'AI_CANCELLED');
    });

    test('the three failure categories map to three different user-facing replies', () => {
        const provider = fallbackResponseFor(AI_OUTCOME.PROVIDER_UNAVAILABLE);
        const timeout = fallbackResponseFor(AI_OUTCOME.TIMEOUT);
        const cancelled = fallbackResponseFor(AI_OUTCOME.CANCELLED);
        assert.notEqual(provider, timeout);
        assert.notEqual(timeout, cancelled);
        assert.notEqual(provider, cancelled);
        assert.match(provider, /gateway/i);
        assert.match(timeout, /too long/i);
        assert.match(cancelled, /stopped/i);
    });

    test('conversation layer returns the category-specific reply for each failure', async () => {
        const providerAdapter = new ScriptedAdapter(() => { throw classifyAsError('AI_PROVIDER', 'gateway down'); });
        const timeoutAdapter = new ScriptedAdapter(() => { throw classifyAsError('AI_TIMEOUT', 'slow'); });

        const provider = await withAdapter(providerAdapter, () => conversation._processWithSkills('Is Paris the capital of France?'));
        const timeout = await withAdapter(timeoutAdapter, () => conversation._processWithSkills('Is Paris the capital of France?'));
        const cancelledAdapter = new ScriptedAdapter(() => { throw classifyAsError('AI_CANCELLED', 'stopped'); });
        const cancelled = await withAdapter(cancelledAdapter, () => conversation._processWithSkills('Is Paris the capital of France?'));

        assert.equal(provider.response, fallbackResponseFor(AI_OUTCOME.PROVIDER_UNAVAILABLE));
        assert.equal(timeout.response, fallbackResponseFor(AI_OUTCOME.TIMEOUT));
        assert.equal(cancelled.response, fallbackResponseFor(AI_OUTCOME.CANCELLED));
        assert.notEqual(provider.response, timeout.response);
        assert.notEqual(timeout.response, cancelled.response);
    });

    test('an unexpected local fault is INTERNAL, never mislabelled as a provider fault', async () => {
        const originalBuilder = aiBrain._contextBuilder;
        aiBrain._contextBuilder = { buildContext() { throw new TypeError('local bug'); }, formatForPrompt() { return ''; } };
        try {
            const result = await aiBrain.processRequest('Is Paris the capital of France?');
            assert.equal(result.outcome, AI_OUTCOME.INTERNAL);
            assert.equal(result.stage, 'context');
            assert.equal(result.code, 'INTERNAL');
            assert.equal(result.error, 'AI Brain encountered an unexpected error', 'raw local error text is not surfaced');
        } finally {
            aiBrain._contextBuilder = originalBuilder;
        }
    });

    test('classifyAiError maps error codes deterministically', () => {
        assert.equal(classifyAiError(classifyAsError('AI_TIMEOUT', 't')).kind, AI_OUTCOME.TIMEOUT);
        assert.equal(classifyAiError(classifyAsError('AI_CANCELLED', 'c')).kind, AI_OUTCOME.CANCELLED);
        assert.equal(classifyAiError(classifyAsError('AI_VALIDATION', 'v')).kind, AI_OUTCOME.INVALID_OUTPUT);
        assert.equal(classifyAiError(classifyAsError('AI_PROVIDER', 'p')).kind, AI_OUTCOME.PROVIDER_UNAVAILABLE);
        assert.equal(classifyAiError(new Error('plain')).kind, AI_OUTCOME.INTERNAL);
    });
});

/** Build an adapter-hierarchy error with a chosen code, for scripted doubles. */
function classifyAsError(code, message) {
    const { AIError, AIValidationError, AIProviderError, AITimeoutError, AICancellationError } = ERROR_TYPES;
    switch (code) {
        case 'AI_TIMEOUT': return new AITimeoutError(message, 1);
        case 'AI_CANCELLED': return new AICancellationError(message);
        case 'AI_VALIDATION': return new AIValidationError(message);
        case 'AI_PROVIDER': return new AIProviderError(message);
        default: return new AIError(message, code);
    }
}
const ERROR_TYPES = await import('../js/ai/modelAdapter.js');

// ==================================================================
// 8. Mock / offline / disabled mode is identified accurately
// ==================================================================

describe('mock, offline and disabled modes are identified, never presented as answers', () => {
    beforeEach(() => { state.clearConversation(); conversation._hasHadInteraction = false; });

    test('the mock adapter is OFFLINE: its text is not an answer and gets the offline reply', async () => {
        const mock = new MockAdapter();
        const result = await withAdapter(mock, () => aiBrain.processRequest('Is Paris the capital of France?'));

        assert.equal(result.success, false);
        assert.equal(result.outcome, AI_OUTCOME.OFFLINE);

        const reply = await withAdapter(mock, () => conversation._processWithSkills('Is Paris the capital of France?'));
        assert.equal(reply.response, fallbackResponseFor(AI_OUTCOME.OFFLINE));
        for (const pattern of LEGACY_GENERIC_REPLIES) {
            assert.doesNotMatch(reply.response, pattern);
        }
    });

    test('a gateway in mock mode (realProvider:false) is OFFLINE even when its text is not JSON', async () => {
        const adapter = new HttpModelAdapter({
            fetchImpl: async () => fakeResponse(200, JSON.stringify({
                text: 'Processed request for: "Is Paris the capital of France?"',
                usage: null,
                model: 'mock-model',
                realProvider: false
            }))
        });
        const result = await withAdapter(adapter, () => aiBrain.processRequest('Is Paris the capital of France?'));
        assert.equal(result.outcome, AI_OUTCOME.OFFLINE);
        assert.equal(result.success, false);
    });

    test('a live gateway answer (realProvider:true) is a valid conversational answer', async () => {
        const adapter = new HttpModelAdapter({
            fetchImpl: async () => fakeResponse(200, JSON.stringify({
                text: JSON.stringify({ response: 'Yes, Paris is the capital of France.' }),
                usage: null,
                model: 'live-model',
                realProvider: true
            }))
        });
        const result = await withAdapter(adapter, () => conversation._processWithSkills('Is Paris the capital of France?'));
        assert.equal(result.skill, 'ai');
        assert.equal(result.response, 'Yes, Paris is the capital of France.');
    });

    test('an offline plan from the mock planner is still validated before running (action request)', async () => {
        const mock = new MockAdapter();
        mock.setCustomPlan(/set a reminder/i, {
            goal: 'set a reminder',
            steps: [{ id: 'step_1', skill: 'reminders', input: 'call mom' }]
        });
        const spies = observeExecution();
        try {
            await withAdapter(mock, () => conversation._processWithSkills('Remind me to call mom at 6 PM'));
            // Whatever runs must be a validated skill call; the offline plan is never executed raw.
            for (const name of spies.seen.skillBody) {
                assert.ok(skillManager.getSkills().some((s) => s.name === name), `${name} is a registered skill`);
            }
        } finally {
            spies.restore();
        }
    });

    test('synthesis in offline mode keeps the factual result instead of mock text', async () => {
        const mock = new MockAdapter();
        const text = await withAdapter(mock, () => aiBrain.generateResponse('What did you do?', { response: 'Saved your note.' }, null));
        assert.equal(text, 'Saved your note.');
    });

    test('AI disabled is reported as DISABLED with its own reply', async () => {
        aiBrain.setEnabled(false);
        try {
            const result = await aiBrain.processRequest('Is Paris the capital of France?');
            assert.equal(result.outcome, AI_OUTCOME.DISABLED);

            const reply = await conversation._processWithSkills('Is Paris the capital of France?');
            assert.equal(reply.response, fallbackResponseFor(AI_OUTCOME.DISABLED));
        } finally {
            aiBrain.setEnabled(true);
        }
    });

    test('the in-process gateway reports realProvider:false for the mock provider', async () => {
        const server = createGatewayServer({ port: 0, host: '127.0.0.1', provider: 'mock', rateLimitPerMinute: 100000 });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const { port } = server.address();
            const res = await fetch(`http://127.0.0.1:${port}/api/ai/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: 'Hello there', responseFormat: 'plan' })
            });
            const body = await res.json();
            assert.equal(res.status, 200);
            assert.equal(body.realProvider, false);

            const health = await fetch(`http://127.0.0.1:${port}/api/health`);
            const healthBody = await health.json();
            assert.equal(healthBody.realProvider, body.realProvider, 'health and generate agree on the provider mode');
            assert.equal(healthBody.realProvider, false);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('end to end through the real gateway: a live upstream answer reaches the user as an answer', async () => {
        const upstream = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: JSON.stringify({ response: 'Yes, Paris is the capital of France.' }) } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
                }));
            });
        });
        await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
        const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`;

        const gateway = createGatewayServer({
            port: 0,
            host: '127.0.0.1',
            provider: 'groq',
            groqApiKey: 'fixture-upstream-key',
            providerEndpoints: { groq: upstreamUrl },
            rateLimitPerMinute: 100000
        });
        await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
        try {
            const url = `http://127.0.0.1:${gateway.address().port}/api/ai/generate`;
            const adapter = new HttpModelAdapter({ gatewayUrl: url });
            const result = await withAdapter(adapter, () => conversation._processWithSkills('Is Paris the capital of France?'));
            assert.equal(result.skill, 'ai');
            assert.equal(result.response, 'Yes, Paris is the capital of France.');
        } finally {
            await new Promise((resolve) => gateway.close(resolve));
            await new Promise((resolve) => upstream.close(resolve));
        }
    });
});

// ==================================================================
// 9. Generic fallback is not returned when a valid answer exists
// ==================================================================

describe('the generic fallback is not returned when a valid natural-language answer was produced', () => {
    beforeEach(() => { state.clearConversation(); conversation._hasHadInteraction = false; });

    test('a valid answer is returned exactly and is never replaced by a canned reply', async () => {
        const answers = [
            'Paris is the capital of France.',
            'Hello! Good to see you.',
            'Quantum computing uses qubits that can be in superposition.'
        ];
        for (const answer of answers) {
            const adapter = new ScriptedAdapter(() => liveAnswer(answer));
            const result = await withAdapter(adapter, () => conversation._processWithSkills('Tell me something interesting'));
            assert.equal(result.response, answer);
            assert.equal(result.skill, 'ai');
        }
    });
});

// ==================================================================
// 10. Diagnostics identify the stage and category, and nothing sensitive
// ==================================================================

describe('diagnostics are safe and useful', () => {
    beforeEach(() => { state.clearConversation(); conversation._hasHadInteraction = false; });

    test('a failed turn logs stage and category, but never the prompt, user text or model output', async () => {
        const SECRET = 'SECRET-MARKER-123';
        const PRIVATE = 'PRIVATE-QUESTION-456';
        const adapter = new HttpModelAdapter({
            fetchImpl: async () => fakeResponse(200, JSON.stringify({
                text: `${SECRET} not json at all`,
                usage: null,
                realProvider: true
            }))
        });
        await withAdapter(adapter, () => conversation._processWithSkills(`Is Paris the capital of France ${PRIVATE}?`));

        const messages = activityMessages();
        assert.ok(messages.some((m) => /AI Brain diagnostic: stage=parse outcome=invalid_output code=ai_validation/.test(m)),
            'a stage/category diagnostic is recorded');
        for (const message of messages) {
            assert.ok(!message.includes(SECRET), 'model output never reaches the activity log');
            assert.ok(!message.includes(PRIVATE), 'user text never reaches the diagnostic');
        }
    });

    test('a plan rejected by PlanValidator is logged as a count, never with model-supplied values', async () => {
        const MODEL_SKILL = 'SECRET-SKILL-789';
        const adapter = new ScriptedAdapter(() => livePlan({
            goal: 'x',
            steps: [{ id: 'step_1', skill: MODEL_SKILL, input: 'y' }]
        }));
        await withAdapter(adapter, () => conversation._processWithSkills('Is Paris the capital of France?'));

        const messages = activityMessages();
        assert.ok(messages.some((m) => /AI plan rejected by Plan Validator \(1 issue\)/.test(m)));
        assert.ok(!messages.some((m) => m.includes(MODEL_SKILL)), 'model-supplied skill name is not logged');
    });

    test('a failed synthesis keeps the factual result and logs only a category', async () => {
        const SECRET = 'SECRET-SYNTH-321';
        const adapter = new ScriptedAdapter(() => { throw new Error(SECRET); });
        const text = await withAdapter(adapter, () => aiBrain.generateResponse('Save my note', { response: 'Saved your note.', success: true }, null));

        assert.equal(text, 'Saved your note.', 'the factual execution report is kept');
        const messages = activityMessages();
        assert.ok(messages.some((m) => /AI Brain synthesis error: stage=synthesize outcome=internal/.test(m)));
        assert.ok(!messages.some((m) => m.includes(SECRET)), 'raw error text is never logged');
    });

    test('formatAiDiagnostic emits only fixed tokens', () => {
        const line = formatAiDiagnostic({ stage: 'generate', kind: 'timeout', code: 'AI_TIMEOUT' });
        assert.equal(line, 'AI Brain diagnostic: stage=generate outcome=timeout code=ai_timeout');
        const hostile = formatAiDiagnostic({ stage: 'x y;rm', kind: '"quoted"', code: 'Bearer abc' });
        assert.doesNotMatch(hostile, /[";]/);
    });
});

// ==================================================================
// 11. Cancellation and lifecycle
// ==================================================================

describe('cancellation and lifecycle', () => {
    beforeEach(() => { state.clearConversation(); conversation._hasHadInteraction = false; });

    test('a stopped turn never starts a deterministic action', async () => {
        const spies = observeExecution();
        try {
            // -1 is a stale generation token: Stop/disable happened before execution.
            // The model is unavailable, so the deterministic action fallback is the
            // only path that could run. The stale token must stop it.
            const failing = new ScriptedAdapter(() => { throw classifyAsError('AI_PROVIDER', 'gateway down'); });
            const result = await withAdapter(failing, () =>
                conversation._processWithSkills('Calculate 25 percent of 800', -1)
            );
            assert.equal(result.skill, 'cancelled');
            assert.equal(result.response, fallbackResponseFor(AI_OUTCOME.CANCELLED));
            assert.deepEqual(spies.seen.executeByName, []);
            assert.deepEqual(spies.seen.executePlan, []);
            assert.deepEqual(spies.seen.agentProcess, []);
        } finally {
            spies.restore();
        }
    });

    test('a validated plan that arrives after Stop is not executed', async () => {
        const adapter = new ScriptedAdapter(() => livePlan({
            goal: 'Calculate 25 percent of 800',
            steps: [{ id: 'step_1', skill: 'calculator', input: '25 percent of 800' }]
        }));
        const spies = observeExecution();
        try {
            const result = await withAdapter(adapter, () => conversation._processWithSkills('Calculate 25 percent of 800', -1));
            assert.equal(result.skill, 'cancelled');
            assert.deepEqual(spies.seen.executePlan, []);
            assert.deepEqual(spies.seen.skillBody, []);
        } finally {
            spies.restore();
        }
    });

    test('a direct answer produced before Stop is still returned to the caller (speech is suppressed separately)', async () => {
        const result = await withAdapter(new ScriptedAdapter(() => liveAnswer('Still returned.')), () =>
            conversation._processWithSkills('Is Paris the capital of France?', -1)
        );
        assert.equal(result.response, 'Still returned.');
    });
});

