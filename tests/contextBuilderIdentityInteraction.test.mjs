// Part 3 / Part 8D ContextBuilder integration.
// Run: node --test tests/contextBuilderIdentityInteraction.test.mjs
// Exercises only deterministic prompt/context assembly; no network access.
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
        return { style: {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return null; } };
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; }
};

// ContextBuilder's existing memory adapter starts its normal reminder timer.
// Keep that pre-existing timer from holding this focused Node test process open.
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
    const handle = nativeSetInterval(...args);
    handle?.unref?.();
    return handle;
};

const { contextBuilder } = await import('../js/ai/contextBuilder.js');
const { ALICE_IDENTITY } = await import('../js/ai/aliceIdentity.js');
const { createInteractionContext, INTERACTION_EMOTIONAL_SIGNALS } = await import('../js/ai/interactionContext.js');
globalThis.setInterval = nativeSetInterval;

function createLegacyContext(overrides = {}) {
    return {
        request: 'Please summarize the project status.',
        tools: [{
            name: 'project-status',
            description: 'Reads the current project status',
            inputs: [{ name: 'project', description: 'Project name' }],
            risk: 'safe'
        }],
        memory: {
            pinnedFacts: [{ text: 'The user prefers concise summaries.' }],
            memories: [{ key: 'project', value: 'ALICE0' }],
            recentTasks: [{ goal: 'Review the project', status: 'completed' }]
        },
        history: [
            { role: 'user', text: 'How is the project going?' },
            { role: 'assistant', text: 'I can summarize its status.' }
        ],
        ...overrides
    };
}

function identitySectionFromFoundation() {
    return [
        'ALICE Identity:',
        `- Name: ${ALICE_IDENTITY.name}`,
        `- Persona: ${ALICE_IDENTITY.persona}`,
        `- Roles: ${ALICE_IDENTITY.roles.join('; ')}`,
        `- Personality: ${ALICE_IDENTITY.personality.join('; ')}`,
        `- Philosophy: ${ALICE_IDENTITY.philosophy.join('; ')}`,
        `- Character principles: ${ALICE_IDENTITY.characterPrinciples.join('; ')}`,
        `- Relationship qualities: ${ALICE_IDENTITY.relationship.qualities.join('; ')}`,
        `- Relationship boundaries: ${ALICE_IDENTITY.relationship.boundaries.join('; ')}`
    ].join('\n');
}

test('adds a deterministic ALICE Identity section generated from the identity foundation', async () => {
    const prompt = contextBuilder.formatForPrompt(createLegacyContext());
    const source = await readFile(new URL('../js/ai/contextBuilder.js', import.meta.url), 'utf8');

    assert.ok(prompt.includes(identitySectionFromFoundation()));
    assert.match(source, /import\s*\{\s*ALICE_IDENTITY\s*\}\s*from\s*['"]\.\/aliceIdentity\.js['"]/);
    assert.match(source, /ALICE_IDENTITY\.roles/);
    assert.match(source, /ALICE_IDENTITY\.personality/);
    assert.match(source, /ALICE_IDENTITY\.philosophy/);
    assert.match(source, /ALICE_IDENTITY\.characterPrinciples/);
    assert.match(source, /ALICE_IDENTITY\.relationship/);
    // The builder consumes the centralized data instead of carrying a second
    // literal copy of its personality list.
    assert.doesNotMatch(source,
        /\[\s*['"]gentle['"]\s*,\s*['"]intelligent['"]\s*,\s*['"]protective['"]\s*,\s*['"]curious['"]/s);
});

test('uses documented safe interaction-context defaults when none is supplied', () => {
    const built = contextBuilder.buildContext({
        request: 'What is the next step?',
        includeTools: false,
        includeMemory: false,
        includeHistory: false,
        includeTaskState: false
    });
    const prompt = contextBuilder.formatForPrompt(built);

    assert.deepEqual(built.interactionContext, createInteractionContext());
    assert.ok(Object.isFrozen(built.interactionContext));
    assert.ok(prompt.includes([
        'Interaction Context:',
        '- Turn type: new',
        '- Intent: unknown',
        '- Response depth: quick',
        '- Personality mode: none',
        '- Broad contextual signal: neutral',
        '- Source: text'
    ].join('\n')));
    assert.match(prompt, /emotionalSignal represents an explicit user-expressed contextual signal detected by ALICE0/i);
    assert.match(prompt, /When emotionalSignal is neutral, handle the request normally and do not assume an emotional state/i);
});

test('renders explicit normalized interaction-context values cleanly and unchanged', () => {
    const interactionContext = createInteractionContext({
        turnType: 'follow_up',
        intent: 'information',
        responseDepth: 'explain',
        mode: 'teacher',
        emotionalSignal: 'curious',
        source: 'text'
    });
    const built = contextBuilder.buildContext({
        request: 'Could you explain that further?',
        interactionContext,
        includeTools: false,
        includeMemory: false,
        includeHistory: false,
        includeTaskState: false
    });
    const prompt = contextBuilder.formatForPrompt(built);

    assert.deepEqual(built.interactionContext, interactionContext);
    assert.ok(prompt.includes([
        'Interaction Context:',
        '- Turn type: follow_up',
        '- Intent: information',
        '- Response depth: explain',
        '- Personality mode: teacher',
        '- Broad contextual signal: curious',
        '- Source: text'
    ].join('\n')));
    assert.doesNotMatch(prompt, /\[object Object\]/);
});

test('Part 8B: renders all interaction fields with an explicit, bounded emotional-signal behavior contract', () => {
    const interactionContext = createInteractionContext({
        turnType: 'follow_up',
        intent: 'clarification',
        responseDepth: 'deep',
        mode: 'guardian',
        emotionalSignal: 'frustrated',
        source: 'voice'
    });
    const built = contextBuilder.buildContext({
        request: 'I am frustrated. Please explain the last step again.',
        interactionContext,
        includeTools: false,
        includeMemory: false,
        includeHistory: false,
        includeTaskState: false
    });
    const prompt = contextBuilder.formatForPrompt(built);

    // The refinement is additive: every established interaction field still
    // reaches the formatted model context alongside emotionalSignal.
    assert.deepEqual(Object.keys(built.interactionContext).sort(), [
        'emotionalSignal', 'intent', 'mode', 'request', 'responseDepth', 'source', 'turnType'
    ]);
    assert.ok(prompt.includes([
        'Interaction Context:',
        '- Turn type: follow_up',
        '- Intent: clarification',
        '- Response depth: deep',
        '- Personality mode: guardian',
        '- Broad contextual signal: frustrated',
        '- Source: voice'
    ].join('\n')));

    assert.match(prompt, /emotionalSignal represents an explicit user-expressed contextual signal detected by ALICE0\./);
    assert.match(prompt, /user's expressed signal, not an emotion experienced by ALICE\./);
    assert.match(prompt, /A non-neutral signal may influence tone, patience, explanation style, and conversational sensitivity\./);
    assert.match(prompt, /Do not treat it as a diagnosis or certainty about the user's internal mental state\./);
    assert.match(prompt, /Remain honest and non-judgmental\./);
    assert.match(prompt, /never overrides safety, permissions, tool validation, or user autonomy\./i);
});

test('Part 8B: handles neutral normally and renders every non-neutral signal unchanged', () => {
    const buildPrompt = emotionalSignal => contextBuilder.formatForPrompt(contextBuilder.buildContext({
        request: 'Offline prompt assembly',
        interactionContext: createInteractionContext({ emotionalSignal }),
        includeTools: false,
        includeMemory: false,
        includeHistory: false,
        includeTaskState: false
    }));

    const neutralPrompt = buildPrompt('neutral');
    assert.ok(neutralPrompt.includes('- Broad contextual signal: neutral'));
    assert.match(neutralPrompt, /When emotionalSignal is neutral, handle the request normally and do not assume an emotional state\./);

    for (const emotionalSignal of INTERACTION_EMOTIONAL_SIGNALS.filter(signal => signal !== 'neutral')) {
        const prompt = buildPrompt(emotionalSignal);
        assert.ok(
            prompt.includes(`- Broad contextual signal: ${emotionalSignal}`),
            `prompt must render non-neutral emotionalSignal ${JSON.stringify(emotionalSignal)} unchanged`
        );
    }
});

test('normalizes invalid interaction values through the Part 2 factory', () => {
    const invalidInteractionContext = {
        turnType: 'continuation',
        intent: 'answer',
        responseDepth: 'detailed',
        mode: 'robot',
        emotionalSignal: 'overjoyed',
        source: 'email'
    };
    const built = contextBuilder.buildContext({
        request: 'Hello',
        interactionContext: invalidInteractionContext,
        includeTools: false,
        includeMemory: false,
        includeHistory: false,
        includeTaskState: false
    });
    const prompt = contextBuilder.formatForPrompt(built);

    assert.deepEqual(built.interactionContext, createInteractionContext(invalidInteractionContext));
    assert.ok(prompt.includes('- Turn type: new'));
    assert.ok(prompt.includes('- Intent: unknown'));
    assert.ok(prompt.includes('- Response depth: quick'));
    assert.ok(prompt.includes('- Personality mode: none'));
    assert.ok(prompt.includes('- Broad contextual signal: neutral'));
    assert.ok(prompt.includes('- Source: text'));
});

test('Part 7B: preserves an explicitly supplied intent in the normalized interaction context', () => {
    // Every allowed intent value survives buildContext() unchanged inside the
    // normalized interaction context, and the prompt renders exactly the
    // preserved value — never an inferred one.
    for (const intent of ['information', 'action', 'conversation', 'clarification', 'unknown']) {
        const built = contextBuilder.buildContext({
            request: 'What is quantum computing?',
            interactionContext: createInteractionContext({ intent }),
            includeTools: false,
            includeMemory: false,
            includeHistory: false,
            includeTaskState: false
        });

        assert.deepEqual(built.interactionContext, createInteractionContext({ intent }),
            `normalized context must preserve the explicit intent "${intent}"`);
        assert.ok(Object.isFrozen(built.interactionContext));

        const prompt = contextBuilder.formatForPrompt(built);
        assert.ok(prompt.includes(`- Intent: ${intent}`),
            `prompt must render the preserved intent "${intent}"`);
    }
});

test('Part 7B: buildContext never infers intent from the request text', () => {
    const built = contextBuilder.buildContext({
        request: 'What is quantum computing?',
        includeTools: false,
        includeMemory: false,
        includeHistory: false,
        includeTaskState: false
    });

    assert.equal(built.interactionContext.intent, 'unknown');
    assert.deepEqual(built.interactionContext, createInteractionContext());
});

test('keeps legacy ContextBuilder prompt sections and callers compatible', () => {
    // This shape intentionally has no interactionContext, matching contexts
    // produced by callers before Part 3.
    const prompt = contextBuilder.formatForPrompt(createLegacyContext());

    assert.match(prompt, /^System:/);
    assert.match(prompt, /Required JSON Output Contract/);
    assert.match(prompt, /Available Tools:\n- project-status: Reads the current project status/);
    assert.match(prompt, /Context & Memory:/);
    assert.match(prompt, /Pinned Facts: The user prefers concise summaries\./);
    assert.match(prompt, /Conversation History:/);
    assert.match(prompt, /User: How is the project going\?/);
    assert.match(prompt, /ALICE: I can summarize its status\./);
    assert.ok(prompt.trimEnd().endsWith('User Request: "Please summarize the project status."'));
    assert.match(prompt, /Interaction Context:\n- Turn type: new/);
});

test('Part 8B: does not duplicate detector logic or introduce network access', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('network access attempted'); };

    try {
        const built = contextBuilder.buildContext({
            request: 'Offline prompt assembly',
            includeTools: false,
            includeMemory: false,
            includeHistory: false,
            includeTaskState: false
        });
        const prompt = contextBuilder.formatForPrompt(built);
        assert.match(prompt, /Offline prompt assembly/);
    } finally {
        globalThis.fetch = originalFetch;
    }

    const source = await readFile(new URL('../js/ai/contextBuilder.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /emotionalSignalDetector|detectEmotionalSignal|SIGNAL_PHRASES|EMOTIONAL_SIGNALS/);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bhttps?:\/\//);
});

test('Part 8D: prompt contains a Response Priority Contract that keeps the user request primary', () => {
    const interactionContext = createInteractionContext({
        turnType: 'follow_up',
        intent: 'information',
        responseDepth: 'explain',
        mode: 'teacher',
        emotionalSignal: 'frustrated',
        source: 'text'
    });
    const prompt = contextBuilder.formatForPrompt(contextBuilder.buildContext({
        request: "I'm frustrated. What is photosynthesis?",
        interactionContext,
        includeTools: false,
        includeMemory: false,
        includeHistory: false,
        includeTaskState: false
    }));

    assert.ok(prompt.includes('Response Priority Contract:'));
    assert.match(prompt, /The user's request is the primary task/);
    assert.match(prompt, /must be answered or handled first/);
    assert.match(prompt, /Emotional Response Guidance may influence communication style/);
    assert.match(prompt, /must never replace, reinterpret, or override the user's actual request/);
    assert.match(prompt, /Never invent an emotional-support response/);

    // The contract sits immediately after Emotional Response Guidance and
    // before the machine-readable output contract.
    const guidanceAt = prompt.indexOf('Emotional Response Guidance:');
    const contractAt = prompt.indexOf('Response Priority Contract:');
    const outputAt = prompt.indexOf('Required JSON Output Contract');
    assert.ok(guidanceAt >= 0 && contractAt > guidanceAt && outputAt > contractAt);
});

test('Part 8D: preserves existing emotional signal, guidance, identity, tools, memory, and history', () => {
    const interactionContext = createInteractionContext({
        turnType: 'follow_up',
        intent: 'action',
        responseDepth: 'quick',
        mode: 'none',
        emotionalSignal: 'sad',
        source: 'voice'
    });
    const prompt = contextBuilder.formatForPrompt(createLegacyContext({
        request: "I'm sad. Calculate 25% of 800.",
        interactionContext
    }));

    // Existing identity, interaction context, and Part 8C guidance stay present.
    assert.ok(prompt.includes(identitySectionFromFoundation()));
    assert.ok(prompt.includes('- Broad contextual signal: sad'));
    assert.ok(prompt.includes('- Expressed signal: sad'));
    assert.ok(prompt.includes('Emotional Response Guidance:'));
    assert.ok(prompt.includes('- Communication tone: gentle and patient'));
    assert.ok(prompt.includes('- Turn type: follow_up'));
    assert.ok(prompt.includes('- Intent: action'));
    assert.ok(prompt.includes('- Source: voice'));

    // Existing identity, output contract, tools, memory, and history remain.
    assert.match(prompt, /^System:/);
    assert.match(prompt, /Required JSON Output Contract/);
    assert.match(prompt, /Available Tools:\n- project-status: Reads the current project status/);
    assert.match(prompt, /Context & Memory:/);
    assert.match(prompt, /Pinned Facts: The user prefers concise summaries\./);
    assert.match(prompt, /Conversation History:/);
    assert.match(prompt, /User: How is the project going\?/);
    assert.match(prompt, /ALICE: I can summarize its status\./);
    assert.ok(prompt.trimEnd().endsWith('User Request: "I\'m sad. Calculate 25% of 800."'));
});

test('Part 8D: does not duplicate detector/guidance implementation or introduce network calls', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('network access attempted'); };

    try {
        const prompt = contextBuilder.formatForPrompt(contextBuilder.buildContext({
            request: 'Offline prompt assembly',
            interactionContext: createInteractionContext({ emotionalSignal: 'lonely' }),
            includeTools: false,
            includeMemory: false,
            includeHistory: false,
            includeTaskState: false
        }));
        assert.ok(prompt.includes('Response Priority Contract:'));
        assert.ok(prompt.includes('- Broad contextual signal: lonely'));
        assert.ok(prompt.includes('- Expressed signal: lonely'));
    } finally {
        globalThis.fetch = originalFetch;
    }

    const source = await readFile(new URL('../js/ai/contextBuilder.js', import.meta.url), 'utf8');
    // Still a prompt-contract renderer: no second detector, no second
    // guidance table, no hardcoded emotional replies, no network.
    assert.match(source, /_buildResponsePriorityContractSection\(/);
    assert.match(source, /import\s*\{\s*getEmotionalResponseGuidance\s*\}\s*from\s*['"]\.\/emotionalResponseGuidance\.js['"]/);
    assert.doesNotMatch(source, /emotionalSignalDetector|detectEmotionalSignal|SIGNAL_PHRASES|EMOTIONAL_SIGNALS/);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bhttps?:\/\//);
    // The builder still does not carry a second copy of the guidance table.
    assert.doesNotMatch(source, /avoid blaming the user|forced cheerfulness|normal conversational tone/i);
});
