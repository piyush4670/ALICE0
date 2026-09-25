// Part 8E: live AI emotional-guidance validation harness (VALIDATION ONLY).
// Run:            node --test tests/part8e-live-response-validation.test.mjs
// Optional live:  ALICE_LIVE_AI_TEST=1 node --test tests/part8e-live-response-validation.test.mjs
//
// Verifies the INPUT CONTRACT that the real ALICE response path delivers to
// the model for the four Part 8E scenarios. Unlike the Part 8C/8D unit tests,
// which give ContextBuilder hand-built InteractionContexts, each request here
// runs through the real path used by conversation.processText():
//
//   conversation._processWithSkills(text, null, 'text')
//     → Part 7C/7D/7E/8A detectors → createInteractionContext()
//     → aiBrain.processRequest() → ContextBuilder buildContext/formatForPrompt
//     → adapter.generate(prompt)   ← only this hop is replaced, through the
//                                    public aiBrain.setAdapter(), by a recorder
//                                    that returns a benign direct response.
//
// Nothing is planned, executed, or sent over the network, and every swap is
// restored. The harness asserts only what the model is GIVEN, never what it
// WILL answer: guidance in a prompt does not guarantee model behaviour. No
// production code, prompt, or model setting is changed; this file only
// imports production modules.
//
// Part 8F update: the intent gap is now closed, so no TODO case remains. As
// filed in Part 8E, the brief expected 'information'/'action' for scenarios
// 1, 2 and 4, but the Part 7C detector matched intent prefixes only at the
// START of the request, so a leading emotional sentence yielded 'unknown'
// (and "Tell me one interesting fact" matched no information prefix). The
// Part 8F detector adds a limited second pass over segment starts after
// sentence boundaries plus narrow "tell me a/an/one/some/something"
// information prefixes; the pinned `delivered` intents below were updated
// deliberately to the brief values.
//
// Optional live check: runs only when ALICE_LIVE_AI_TEST=1 and is skipped
// otherwise. It sends the same four requests through the configured
// HttpModelAdapter to the already-running local gateway (node
// server/gateway.js), the only holder of provider credentials. If that gateway
// needs LOCAL_TRUST_TOKEN or runs off the default URL, export LOCAL_TRUST_TOKEN
// / AI_GATEWAY_URL for the test process too; the adapter reads them itself.
// It records whether a response was received, checks only deterministic
// contract properties (never wording), and prints no credentials, headers,
// URLs, environment values, or model text.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ---------------------------------------------------------------------------
// Minimal browser globals so the real conversation path can be imported
// (same shape as tests/conversationEmotionalSignalIntegration.test.mjs).
// ---------------------------------------------------------------------------
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
// Pre-existing module timers must not hold this Node test process open.
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
    const handle = nativeSetInterval(...args);
    handle?.unref?.();
    return handle;
};

// ---------------------------------------------------------------------------
// Network gate: closed for the deterministic harness. Only the optional live
// test opens it, and only around its own four requests.
// ---------------------------------------------------------------------------
const nativeFetch = globalThis.fetch;
const network = { open: false, blocked: 0, attempts: 0, statuses: [] };
globalThis.fetch = async (...args) => {
    if (!network.open || typeof nativeFetch !== 'function') {
        network.blocked += 1;
        throw new Error('Part 8E: unexpected network access from the deterministic harness');
    }
    network.attempts += 1;
    const response = await nativeFetch(...args);
    network.statuses.push(response.status);
    return response;
};

const { conversation } = await import('../js/conversation.js');
const { aiBrain } = await import('../js/ai/aiBrain.js');
const { ModelAdapter } = await import('../js/ai/modelAdapter.js');
const { HttpModelAdapter } = await import('../js/ai/httpModelAdapter.js');
const { contextBuilder } = await import('../js/ai/contextBuilder.js');
const { createInteractionContext } = await import('../js/ai/interactionContext.js');
const { getEmotionalResponseGuidance } = await import('../js/ai/emotionalResponseGuidance.js');
const { detectEmotionalSignal } = await import('../js/ai/emotionalSignalDetector.js');
const { detectIntent } = await import('../js/ai/intentDetector.js');
const { detectResponseDepth } = await import('../js/ai/responseDepthDetector.js');
const { detectPersonalityMode } = await import('../js/ai/personalityModeDetector.js');
const { toolDiscovery } = await import('../js/ai/toolDiscovery.js');
const { CONFIG } = await import('../js/config.js');
globalThis.setInterval = nativeSetInterval;

// ---------------------------------------------------------------------------
// Scenarios
//   brief     — context values the Part 8E brief expects.
//   delivered — what the existing production detectors deliver today, pinned
//               so any change to the model's input contract is noticed.
//   gap       — why a brief value is not delivered (the TODO reason).
// ---------------------------------------------------------------------------
const SCENARIOS = [
    {
        id: 'S1 emotional + information',
        request: "I'm frustrated. What is photosynthesis?",
        brief: { emotionalSignal: 'frustrated', intent: 'information', responseDepth: 'quick' },
        delivered: { turnType: 'new', intent: 'information', responseDepth: 'quick', mode: null, emotionalSignal: 'frustrated', source: 'text' },
        gap: null // Part 8F: second pass finds "What ..." after the preface.
    },
    {
        id: 'S2 emotional + action',
        request: "I'm sad. Calculate 25% of 800.",
        brief: { emotionalSignal: 'sad', intent: 'action' },
        delivered: { turnType: 'new', intent: 'action', responseDepth: 'quick', mode: null, emotionalSignal: 'sad', source: 'text' },
        gap: null // Part 8F: second pass finds "Calculate ..." after the preface.
    },
    {
        id: 'S3 explicit explanation',
        request: 'Explain photosynthesis gently.',
        brief: {}, // The brief defers to the existing detector contracts here.
        delivered: { turnType: 'new', intent: 'information', responseDepth: 'explain', mode: null, emotionalSignal: 'neutral', source: 'text' },
        gap: null
    },
    {
        id: 'S4 casual/curious',
        request: "I'm bored. Tell me one interesting fact.",
        brief: { emotionalSignal: 'bored', intent: 'information' },
        delivered: { turnType: 'new', intent: 'information', responseDepth: 'quick', mode: null, emotionalSignal: 'bored', source: 'text' },
        gap: null // Part 8F: second pass plus narrow "tell me one" prefix.
    }
];
const [S1, S2, S3, S4] = SCENARIOS;

// The Part 8C tone label identifies which guidance entry reached the model.
const EXPECTED_TONE = Object.freeze({
    frustrated: 'patient and solution-focused',
    sad: 'gentle and patient',
    neutral: 'normal conversational tone',
    bored: 'engaging where appropriate'
});

// Part 8D rules that keep the user's request the primary task.
const PRIORITY_RULES = Object.freeze([
    "- The user's request is the primary task and must be answered or handled first.",
    '- Interaction metadata provides context for communication only.',
    "- Emotional guidance must never replace, reinterpret, or override the user's actual request.",
    '- Never invent an emotional-support response when the user asked for an unrelated informational or actionable task.',
    '- Never let emotional guidance override safety, permissions, validation, confirmation, or user autonomy.'
]);

// Prompt sections in the order the model receives them.
const SECTION_ORDER = Object.freeze([
    'System:', 'ALICE Identity:', 'Interaction Context:', 'Emotional Response Guidance:',
    'Response Priority Contract:', 'Required JSON Output Contract', 'Available Tools:', 'User Request:'
]);

// Interaction Context prompt lines, keyed by InteractionContext field.
const INTERACTION_LABELS = Object.freeze({
    turnType: 'Turn type',
    intent: 'Intent',
    responseDepth: 'Response depth',
    mode: 'Personality mode',
    emotionalSignal: 'Broad contextual signal',
    source: 'Source'
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function occurrences(text, needle) {
    return text.split(needle).length - 1;
}

/** ContextBuilder joins prompt sections with a blank line. */
function blocksOf(prompt) {
    return prompt.split('\n\n');
}

function blockIndex(prompt, heading) {
    return blocksOf(prompt).findIndex((block) => block.startsWith(heading));
}

function sectionAt(prompt, heading) {
    const matches = blocksOf(prompt).filter((block) => block.startsWith(heading));
    assert.equal(matches.length, 1, `the prompt must contain exactly one "${heading}" section`);
    return matches[0];
}

/** The Interaction Context values exactly as rendered for the model. */
function renderedInteraction(prompt) {
    const lines = sectionAt(prompt, 'Interaction Context:').split('\n');
    const rendered = {};
    for (const [field, label] of Object.entries(INTERACTION_LABELS)) {
        const line = lines.find((l) => l.startsWith(`- ${label}: `));
        rendered[field] = line?.slice(`- ${label}: `.length);
    }
    return rendered;
}

/**
 * The expected "Emotional Response Guidance:" section, derived from the Part
 * 8C module so this harness carries no second copy of the guidance table.
 */
function expectedGuidanceSection(signal) {
    const guidance = getEmotionalResponseGuidance(signal);
    return [
        'Emotional Response Guidance:',
        `- Expressed signal: ${guidance.signal}`,
        `- Communication tone: ${guidance.tone}`,
        '- Communication guidance:',
        ...guidance.guidance.map((rule) => `  - ${rule}`),
        `- Scope: ${guidance.scope}`,
        '- Safety boundaries:',
        ...guidance.safety.map((boundary) => `  - ${boundary}`),
        '- These are communication guidelines, not commands: the user request stays authoritative.'
    ].join('\n');
}

/** The context conversation.js builds from the production detectors (fresh text turn). */
function detectorContext(request) {
    return createInteractionContext({
        turnType: 'new',
        intent: detectIntent(request).intent,
        responseDepth: detectResponseDepth(request).depth,
        mode: detectPersonalityMode(request).mode,
        emotionalSignal: detectEmotionalSignal(request).signal,
        source: 'text'
    });
}

/** ContextBuilder's own rendering, with no conversation or adapter involved. */
function renderDirect(request, interactionContext) {
    return contextBuilder.formatForPrompt(contextBuilder.buildContext({ request, interactionContext }));
}

/** Call-through spy on target[method]; restore() removes every trace of it. */
function spyOn(target, method, onCall) {
    const hadOwn = Object.hasOwn(target, method);
    const original = target[method];
    target[method] = function spy(...args) {
        onCall(args);
        return original.apply(this, args);
    };
    return () => {
        if (hadOwn) target[method] = original;
        else delete target[method];
    };
}

const CAPTURE_REPLY = 'Part 8E capture: prompt recorded; no model was called.';

/** Records every generate() call and answers with a benign direct response. */
class PromptRecorder extends ModelAdapter {
    constructor() {
        super({});
        this.calls = [];
    }

    async generate(prompt, options = {}) {
        this.calls.push({ prompt, options: { ...options } });
        return { text: '', structured: { response: CAPTURE_REPLY } };
    }
}

/**
 * Run one request through the real conversation → AI Brain → ContextBuilder
 * path and capture what reaches the model adapter. Every run is a fresh 'new'
 * text turn; the configured adapter and aiBrain.processRequest are restored.
 */
async function captureRealPath(request) {
    const configuredAdapter = aiBrain.getAdapter();
    const recorder = new PromptRecorder();
    const brainCalls = [];
    const blockedBefore = network.blocked;
    const restoreSpy = spyOn(aiBrain, 'processRequest', (args) => brainCalls.push(args));
    aiBrain.setAdapter(recorder);
    conversation.clearHistory();
    try {
        const result = await conversation._processWithSkills(request, null, 'text');
        assert.equal(brainCalls.length, 1, 'the request must take the AI Brain path exactly once');
        assert.equal(recorder.calls.length, 1, 'the model adapter must be called exactly once');
        assert.equal(network.blocked, blockedBefore, 'the captured run must not touch the network');
        const [text, brainOptions] = brainCalls[0];
        return {
            result,
            text,
            brainOptions,
            interactionContext: brainOptions?.interactionContext,
            prompt: recorder.calls[0].prompt,
            adapterOptions: recorder.calls[0].options
        };
    } finally {
        aiBrain.setAdapter(configuredAdapter);
        restoreSpy();
    }
}

/**
 * Checks shared by every scenario, made against what the model actually
 * sees: the delivered metadata, the Part 8C guidance, the Part 8D priority
 * contract, the primacy of the user's request, and the Phase 6.4 output
 * contract.
 */
function assertDeliveredContract(capture, scenario) {
    const { request, delivered, id } = scenario;
    const { prompt, interactionContext } = capture;

    // Real AI path: the request is forwarded verbatim with metadata only, and
    // the recorder's direct response comes back untouched (nothing executed).
    assert.deepEqual(capture.result, { response: CAPTURE_REPLY, skill: 'ai' });
    assert.equal(capture.text, request);
    assert.deepEqual(Object.keys(capture.brainOptions), ['interactionContext']);

    // The metadata follows the existing detector contracts and equals the
    // values pinned for this scenario.
    assert.deepEqual(interactionContext, detectorContext(request));
    assert.deepEqual({ ...interactionContext }, { request: '', ...delivered },
        `${id}: the delivered InteractionContext changed; update the pinned values and TODO list deliberately`);

    // The model sees exactly that metadata.
    assert.deepEqual(renderedInteraction(prompt), { ...delivered, mode: delivered.mode ?? 'none' });

    // Part 8C: guidance for the delivered signal, rendered from the module, once.
    assert.equal(sectionAt(prompt, 'Emotional Response Guidance:'), expectedGuidanceSection(delivered.emotionalSignal));
    assert.equal(occurrences(prompt, '- Communication tone: '), 1);
    assert.ok(prompt.includes(`- Communication tone: ${EXPECTED_TONE[delivered.emotionalSignal]}\n`),
        `${id}: expected the "${delivered.emotionalSignal}" guidance`);

    // Part 8D: the Response Priority Contract directly follows the guidance.
    const contract = sectionAt(prompt, 'Response Priority Contract:');
    for (const rule of PRIORITY_RULES) {
        assert.ok(contract.includes(rule), `${id}: missing priority rule: ${rule}`);
    }
    const positions = SECTION_ORDER.map((heading) => blockIndex(prompt, heading));
    positions.forEach((position, i) => {
        assert.ok(position >= 0, `${id}: missing "${SECTION_ORDER[i]}" section`);
        if (i > 0) assert.ok(position > positions[i - 1], `${id}: "${SECTION_ORDER[i]}" is out of order`);
    });
    assert.equal(blockIndex(prompt, 'Response Priority Contract:'), blockIndex(prompt, 'Emotional Response Guidance:') + 1);

    // The user's request is the primary task: verbatim, once, as the final section.
    assert.equal(occurrences(prompt, request), 1, `${id}: the request must appear exactly once`);
    assert.equal(blocksOf(prompt).at(-1), `User Request: "${request}"`);

    // Phase 6.4 output contract, requested in plan (JSON) mode.
    assert.equal(occurrences(prompt, 'Required JSON Output Contract'), 1);
    assert.ok(prompt.includes('{"response": "your natural-language answer"}'));
    assert.equal(capture.adapterOptions.responseFormat, 'plan');

    // The configured HTTP adapter refuses longer prompts before any model sees them.
    assert.ok(prompt.length <= CONFIG.ai.gateway.maxPromptChars,
        `${id}: prompt is ${prompt.length} chars; the HTTP adapter limit is ${CONFIG.ai.gateway.maxPromptChars}`);
}

// ---------------------------------------------------------------------------
// Deterministic input-contract validation (always runs; no network)
// ---------------------------------------------------------------------------
describe('Part 8E: the real response path delivers the Parts 8A–8D input contract', { concurrency: 1 }, () => {
    test('preconditions: the real, configured AI response path is active', () => {
        assert.equal(CONFIG.ai.enabled, true);
        assert.equal(aiBrain.isEnabled(), true);
        assert.equal(CONFIG.ai.adapter, 'http');
        assert.ok(aiBrain.getAdapter() instanceof HttpModelAdapter, 'the configured adapter is the HTTP adapter');
        assert.equal(aiBrain.getContextBuilder(), contextBuilder, 'the AI Brain uses the production ContextBuilder');
        assert.ok(toolDiscovery.hasTool('calculator'), 'the calculator skill is registered');
    });

    test(`${S1.id}: "${S1.request}"`, async () => {
        const capture = await captureRealPath(S1.request);
        assertDeliveredContract(capture, S1);

        // Brief: frustrated guidance; depth stays 'quick' because the request
        // carries no explicit depth cue (the detector reports its default).
        assert.equal(capture.interactionContext.emotionalSignal, 'frustrated');
        assert.equal(capture.interactionContext.responseDepth, 'quick');
        assert.equal(detectResponseDepth(S1.request).confidence, 'low');
        // Part 8F: brief intent 'information' is now delivered.
    });

    test(`${S2.id}: "${S2.request}"`, async () => {
        const capture = await captureRealPath(S2.request);
        assertDeliveredContract(capture, S2);
        const { prompt } = capture;

        // Brief: sad guidance.
        assert.equal(capture.interactionContext.emotionalSignal, 'sad');

        // Brief: the calculator/action output contract reaches the model.
        assert.ok(prompt.includes(
            '{"goal": "overall user goal", "steps": [{"id": "step1", "skill": "registered-skill-name", "input": "skill input"}]}'));
        assert.ok(prompt.includes(
            '6. Use ONLY the skill names listed under "Available Tools" below. Never invent a skill or an action.'));
        assert.ok(prompt.includes('Actionable request: "Calculate 25 percent of 800."'));
        assert.ok(prompt.includes(
            'Reply: {"goal": "Calculate 25 percent of 800", "steps": [{"id": "step1", "skill": "calculator", "input": "25 percent of 800"}]}'));
        assert.match(sectionAt(prompt, 'Available Tools:'), /^- calculator: /m);
        // Part 8F: brief intent 'action' is now delivered.
    });

    test(`${S3.id}: "${S3.request}"`, async () => {
        const capture = await captureRealPath(S3.request);
        assertDeliveredContract(capture, S3);
        const { prompt, interactionContext } = capture;

        // responseDepth follows the existing Part 7D contract: "explain" is an explicit cue.
        assert.deepEqual({ ...detectResponseDepth(S3.request) }, { depth: 'explain', confidence: 'high' });
        assert.equal(interactionContext.responseDepth, 'explain');

        // emotionalSignal follows the existing Part 8A contract: "gently" is
        // not an explicit emotional phrase, so the signal stays neutral.
        assert.deepEqual({ ...detectEmotionalSignal(S3.request) }, { signal: 'neutral', confidence: 'low' });
        assert.equal(interactionContext.emotionalSignal, 'neutral');
        assert.ok(prompt.includes(
            '- When emotionalSignal is neutral, handle the request normally and do not assume an emotional state.'));

        // Part 7E: a bare "gently" is not a mode cue ("be gentle" / "talk gently" are).
        assert.equal(interactionContext.mode, null);

        // No behaviour change: byte-identical to a fresh ContextBuilder
        // rendering of the same detector-built context.
        assert.ok(prompt === renderDirect(S3.request, detectorContext(S3.request)),
            'the real-path prompt must equal ContextBuilder output for the detector-built context');
    });

    test(`${S4.id}: "${S4.request}"`, async () => {
        const capture = await captureRealPath(S4.request);
        assertDeliveredContract(capture, S4);

        // Brief: bored communication guidance; the actual request stays
        // present and primary (verbatim, final section — asserted above).
        assert.equal(capture.interactionContext.emotionalSignal, 'bored');
        // Part 8F: brief intent 'information' is now delivered.
    });

    test('the captured prompt is what ContextBuilder renders and what the configured adapter would send', async () => {
        const configuredAdapter = aiBrain.getAdapter();
        for (const scenario of SCENARIOS) {
            const capture = await captureRealPath(scenario.request);
            const again = await captureRealPath(scenario.request);
            assert.ok(again.prompt === capture.prompt, `${scenario.id}: the prompt must be deterministic`);

            // The recorder observed ContextBuilder's own output and added nothing.
            assert.ok(capture.prompt === renderDirect(scenario.request, capture.interactionContext),
                `${scenario.id}: the captured prompt must equal ContextBuilder output`);

            // The configured adapter would send it unchanged (built locally, no network).
            const outbound = configuredAdapter.buildRequest(capture.prompt, capture.adapterOptions);
            assert.ok(outbound.body.prompt === capture.prompt,
                `${scenario.id}: the HTTP adapter must forward the prompt unchanged`);
            assert.equal(outbound.body.responseFormat, 'plan');
        }
        assert.equal(network.blocked, 0);
    });

    test('the harness only observes: the real path is restored and nothing touched the network', async () => {
        const adapterBefore = aiBrain.getAdapter();
        const aiConfigBefore = JSON.stringify(CONFIG.ai);
        for (const scenario of SCENARIOS) await captureRealPath(scenario.request);

        assert.equal(aiBrain.getAdapter(), adapterBefore, 'the configured adapter is restored');
        assert.equal(Object.hasOwn(aiBrain, 'processRequest'), false, 'no spy is left on the AI Brain');
        assert.equal(JSON.stringify(CONFIG.ai), aiConfigBefore, 'AI configuration is untouched');
        assert.equal(network.blocked, 0, 'no network access was attempted');
    });
});

// ---------------------------------------------------------------------------
// Brief expectations the existing detectors do not meet. Reported as TODO so
// the gap stays visible without failing the suite; a divergence without a
// documented gap is NOT marked TODO and therefore fails.
// ---------------------------------------------------------------------------
describe('Part 8E: brief expectations not met by the existing detectors (TODO, reported)', { concurrency: 1 }, () => {
    for (const scenario of SCENARIOS) {
        for (const [field, expected] of Object.entries(scenario.brief)) {
            if (scenario.delivered[field] === expected) continue; // Hard-asserted above.
            test(`${scenario.id}: brief expects ${field} = ${expected}`, { todo: scenario.gap ?? false }, async () => {
                const { interactionContext, prompt } = await captureRealPath(scenario.request);
                assert.equal(interactionContext[field], expected);
                assert.ok(prompt.includes(`- ${INTERACTION_LABELS[field]}: ${expected}\n`));
            });
        }
    }
});

// ---------------------------------------------------------------------------
// Optional live AI validation — explicit opt-in only (ALICE_LIVE_AI_TEST=1).
// ---------------------------------------------------------------------------
const LIVE_FLAG = 'ALICE_LIVE_AI_TEST';
const LIVE_ENABLED = process.env[LIVE_FLAG] === '1';

/**
 * Classify one live result using deterministic contract checks only. The
 * returned line holds no model text, URLs, headers, or environment values.
 */
function classifyLiveResult(scenario, result, statuses) {
    const { id } = scenario;
    assert.ok(result && typeof result === 'object', `${id}: processRequest resolves to a result object`);
    const received = statuses.some((status) => status >= 200 && status < 300);

    let kind;
    let detail;
    if (result.success === true && result.isMultiStep === true) {
        assert.ok(Array.isArray(result.plan) && result.plan.length >= 1 && result.plan.length <= CONFIG.ai.maxSteps,
            `${id}: a plan is validated and bounded`);
        for (const step of result.plan) {
            assert.ok(toolDiscovery.hasTool(step.skill), `${id}: a plan may only use registered skills`);
        }
        kind = 'plan';
        detail = `steps=${result.plan.length}`;
    } else if (result.success === true) {
        assert.equal(typeof result.response, 'string', `${id}: a direct response is text`);
        assert.ok(result.response.trim().length > 0 && result.response.length <= CONFIG.ai.maxOutputSize,
            `${id}: a direct response is non-empty and bounded`);
        kind = 'response';
        detail = `chars=${result.response.length}`;
    } else {
        assert.equal(result.fallback, true, `${id}: a failed request falls back safely`);
        kind = received ? 'rejected' : 'none';
        detail = `code=${result.code || (result.validationErrors ? 'PLAN_REJECTED' : 'UNKNOWN')}`;
    }

    const accepted = kind === 'plan' || kind === 'response';
    assert.ok(!accepted || received, `${id}: an accepted answer must come from a gateway response`);
    const http = statuses.length > 0 ? ` http=${statuses.join(',')}` : '';
    return {
        received,
        detail,
        line: `live ${id}: received=${received ? 'yes' : 'no'} accepted=${accepted ? 'yes' : 'no'} kind=${kind} ${detail}${http}`
    };
}

describe('Part 8E: optional live AI validation', { concurrency: 1 }, () => {
    test('live: the four requests reach the model through the configured adapter and gateway', {
        skip: LIVE_ENABLED ? false : `set ${LIVE_FLAG}=1 to run against the running local gateway`,
        timeout: 120_000
    }, async (t) => {
        const adapter = aiBrain.getAdapter();
        assert.ok(adapter instanceof HttpModelAdapter, 'live validation uses the configured HTTP adapter only');

        const records = [];
        for (const scenario of SCENARIOS) {
            // The exact metadata and prompt the real path builds (validated above).
            const capture = await captureRealPath(scenario.request);
            const sentPrompts = [];
            const attemptsBefore = network.attempts;
            const statusesBefore = network.statuses.length;
            const restoreSpy = spyOn(adapter, 'generate', ([prompt]) => sentPrompts.push(prompt));
            network.open = true;
            let result;
            try {
                result = await aiBrain.processRequest(scenario.request, {
                    interactionContext: capture.interactionContext
                });
            } finally {
                network.open = false;
                restoreSpy();
            }

            assert.equal(sentPrompts.length, 1, `${scenario.id}: exactly one generation call`);
            assert.ok(sentPrompts[0] === capture.prompt, `${scenario.id}: the live request carries the validated prompt`);
            assert.ok(network.attempts - attemptsBefore <= 1, `${scenario.id}: at most one gateway request`);

            const record = classifyLiveResult(scenario, result, network.statuses.slice(statusesBefore));
            records.push(record);
            t.diagnostic(record.line);
        }

        assert.ok(records.some((record) => record.received),
            `live validation was enabled but no model response was received (${records.map((r) => r.detail).join(', ')}). `
            + 'Check that the local gateway is running (node server/gateway.js) and, if it requires one, '
            + 'that LOCAL_TRUST_TOKEN is exported for this test process.');
    });
});
