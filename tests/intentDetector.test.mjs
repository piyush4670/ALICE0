// Part 7C: Deterministic Intent Detection v1 — focused detector tests.
// Run: node --test tests/intentDetector.test.mjs
//
// Uses only Node built-ins and the pure detector module. No network,
// no browser mocks, no LLM, no skills, no permissions. Verifies:
// A information · B action · C conversation · D clarification · E unknown
// F case normalization · G whitespace normalization · H clarification
// precedence · I action precedence · J false-positive protection ·
// K no network access · L exact intent/confidence contract ·
// Q detection performs no side effects (skills/permissions/agent).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { DETECTED_INTENTS, DETECTION_CONFIDENCES, detectIntent } from '../js/ai/intentDetector.js';

const ALLOWED_INTENTS = ['information', 'action', 'conversation', 'clarification', 'unknown'];
const ALLOWED_CONFIDENCES = ['high', 'low'];

/** Assert the exact documented contract for one detection result. */
function assertContract(result, label) {
    assert.ok(result && typeof result === 'object', `${label}: result must be an object`);
    assert.deepEqual(Object.keys(result).sort(), ['confidence', 'intent'],
        `${label}: result must have exactly { intent, confidence }`);
    assert.ok(ALLOWED_INTENTS.includes(result.intent),
        `${label}: intent "${result.intent}" not in allowed set`);
    assert.ok(ALLOWED_CONFIDENCES.includes(result.confidence),
        `${label}: confidence "${result.confidence}" must be qualitative 'high' | 'low'`);
    assert.equal(typeof result.intent, 'string', `${label}: intent must be a string`);
    assert.equal(typeof result.confidence, 'string', `${label}: confidence must never be numeric`);
    assert.equal(Object.isFrozen(result), true, `${label}: result must be frozen`);
}

function expectIntent(request, intent, confidence = 'high') {
    const result = detectIntent(request);
    assertContract(result, JSON.stringify(request));
    assert.deepEqual(result, { intent, confidence },
        `${JSON.stringify(request)} → expected ${intent}/${confidence}`);
    return result;
}

describe('Part 7C deterministic intent detector', () => {
    // --- A. Information ------------------------------------------------------
    test('A. obvious informational requests → information/high', () => {
        expectIntent('What is photosynthesis?', 'information');
        expectIntent('Explain quantum computing', 'information');
        expectIntent('Tell me about black holes', 'information');
        expectIntent('How does a battery work?', 'information');
        expectIntent('Why is the sky blue?', 'information');
        expectIntent('When did the program start?', 'information');
        expectIntent('Where is the nearest library?', 'information');
        expectIntent('Who invented the telescope?', 'information');
        expectIntent('How do magnets work?', 'information');
        expectIntent('How is steel made?', 'information');
    });

    // --- B. Action -----------------------------------------------------------
    test('B. obvious action requests → action/high', () => {
        expectIntent('Open YouTube', 'action');
        expectIntent('Set a reminder', 'action');
        expectIntent('Set a reminder for 5 PM', 'action');
        expectIntent('Calculate 25 times 4', 'action');
        expectIntent("Search the web for today's weather", 'action');
        expectIntent('Launch the browser', 'action');
        expectIntent('Start a timer', 'action');
        expectIntent('Create a note', 'action');
        expectIntent('Delete the last reminder', 'action');
        expectIntent('Remind me to call mom', 'action');
        expectIntent('Play some music', 'action');
        expectIntent('Navigate home', 'action');
        expectIntent('Go to settings', 'action');
    });

    // --- C. Conversation -----------------------------------------------------
    test('C. obvious conversational requests → conversation/high', () => {
        expectIntent('Hey Alice', 'conversation');
        expectIntent('Good morning', 'conversation');
        expectIntent('How are you?', 'conversation');
        expectIntent('Thank you Alice', 'conversation');
        expectIntent('Hello', 'conversation');
        expectIntent('Hi there', 'conversation');
        expectIntent('Good evening', 'conversation');
        expectIntent('Thanks', 'conversation');
        expectIntent('Bye', 'conversation');
        expectIntent('Goodbye', 'conversation');
    });

    // --- D. Clarification ----------------------------------------------------
    test('D. obvious clarification requests → clarification/high', () => {
        expectIntent('What do you mean?', 'clarification');
        expectIntent('Can you clarify?', 'clarification');
        expectIntent('Explain that again', 'clarification');
        expectIntent("I didn't understand", 'clarification');
        expectIntent("I don't understand", 'clarification');
        expectIntent('What does that mean?', 'clarification');
        expectIntent('Explain again', 'clarification');
        expectIntent('Please clarify', 'clarification');
    });

    // --- E. Unknown ----------------------------------------------------------
    test('E. empty, whitespace, ambiguous, and random text → unknown/low', () => {
        expectIntent('', 'unknown', 'low');
        expectIntent('   ', 'unknown', 'low');
        expectIntent('\t \n ', 'unknown', 'low');
        expectIntent('the meaning of the passage is unclear', 'unknown', 'low');
        expectIntent('purple elephants danced quietly', 'unknown', 'low');
        expectIntent('asdfghjkl12345', 'unknown', 'low');
        expectIntent('xX_random-text_9000 vX', 'unknown', 'low');
        expectIntent('I was wondering', 'unknown', 'low');
        expectIntent('the weather seems nice today', 'unknown', 'low');
        // Invalid input types fall back conservatively and never throw.
        for (const invalid of [null, undefined, 42, true, false, {}, [], ['open youtube'], Symbol('x')]) {
            expectIntent(invalid, 'unknown', 'low');
        }
    });

    // --- F. Case normalization ----------------------------------------------
    test('F. matching is case-insensitive', () => {
        expectIntent('WHAT IS PHOTOSYNTHESIS?', 'information');
        expectIntent('OPEN YOUTUBE', 'action');
        expectIntent('EXPLAIN THAT AGAIN', 'clarification');
        expectIntent('GOOD MORNING', 'conversation');
        expectIntent('hOw Do BaTtErIeS wOrK?', 'information');
    });

    // --- G. Whitespace normalization ----------------------------------------
    test('G. leading/trailing and repeated whitespace is normalized', () => {
        expectIntent('  Open   YouTube  ', 'action');
        expectIntent('\n\tExplain quantum   computing\n', 'information');
        expectIntent('   Hey   Alice   ', 'conversation');
        expectIntent('\r\n What do   you mean? \r\n', 'clarification');
        expectIntent('   ', 'unknown', 'low');
    });

    // --- H. Clarification precedence ----------------------------------------
    test('H. clarification wins over "what"/"explain" informational wording', () => {
        expectIntent('What do you mean?', 'clarification');          // also "what…"
        expectIntent('What does that mean?', 'clarification');       // also "what…"
        expectIntent('Can you explain that again?', 'clarification');// also "explain…"
        expectIntent('Explain again what you just said', 'clarification');
        expectIntent('Why? I did not understand, can you clarify', 'clarification');
        // Even with an action-looking lead, an explicit clarification phrase wins.
        expectIntent('Start over and explain that again', 'clarification');
    });

    // --- I. Action precedence ------------------------------------------------
    test('I. obvious action wins over informational wording', () => {
        expectIntent('Search the web for what is photosynthesis', 'action');
        expectIntent('Calculate why the sky is blue', 'action');
        expectIntent('Open YouTube and explain how it works', 'action');
        expectIntent('Create a note about who invented radio', 'action');
        expectIntent('Set a reminder to ask how are you later', 'action');
    });

    // --- J. False-positive protection ---------------------------------------
    test('J. keyword fragments inside unrelated words do not trigger intents', () => {
        // "hi" inside "which" / "Ohio" must not be conversation.
        expectIntent('which direction is the store', 'unknown', 'low');
        expectIntent('ohio is nice this time of year', 'unknown', 'low');
        // "open" inside "Opening…" must not be action.
        expectIntent('Opening remarks began promptly', 'unknown', 'low');
        // "who" inside "Whoever…" must not be information.
        expectIntent('Whoever holds the key', 'unknown', 'low');
        // "what" inside "Whatsoever…" must not be information.
        expectIntent('Whatsoever damage occurred', 'unknown', 'low');
        // "hello" inside a longer token must not be conversation.
        expectIntent('shellolike shapes', 'unknown', 'low');
        // "bye" inside "goodbye" is fine (goodbye itself is a phrase), but
        // "bye" glued to neighbouring letters must not match.
        expectIntent('byebot is offline', 'unknown', 'low');
        // "thanks" embedded in a larger token must not match.
        expectIntent('nothankssir', 'unknown', 'low');
    });

    // --- K. No network access ------------------------------------------------
    test('K. detection performs no network access', async () => {
        const originalFetch = globalThis.fetch;
        const originalWebSocket = globalThis.WebSocket;
        const originalXHR = globalThis.XMLHttpRequest;
        globalThis.fetch = () => { throw new Error('network access attempted'); };
        globalThis.WebSocket = undefined;
        globalThis.XMLHttpRequest = undefined;
        try {
            expectIntent('What is photosynthesis?', 'information');
            expectIntent('Open YouTube', 'action');
            expectIntent('Hey Alice', 'conversation');
            expectIntent('What do you mean?', 'clarification');
            expectIntent('', 'unknown', 'low');
        } finally {
            globalThis.fetch = originalFetch;
            globalThis.WebSocket = originalWebSocket;
            globalThis.XMLHttpRequest = originalXHR;
        }

        // The module source itself must be free of I/O hooks.
        const source = await readFile(new URL('../js/ai/intentDetector.js', import.meta.url), 'utf8');
        assert.doesNotMatch(source, /^\s*import\s/m, 'module must not import anything');
        assert.doesNotMatch(source, /\brequire\s*\(/, 'module must not use require');
        assert.doesNotMatch(source, /\brequire\s*\(/, 'module must not use require');
        assert.doesNotMatch(source,
            /\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:|net\.connect|dgram\.|child_process|navigator\.|localStorage/,
            'module must not reference network or process I/O');
    });

    // --- L. Exact contract ---------------------------------------------------
    test('L. every result follows the exact intent/confidence contract', () => {
        const requests = [
            'What is photosynthesis?', 'Explain quantum computing', 'Tell me about black holes',
            'Open YouTube', 'Set a reminder', 'Calculate 25 times 4',
            'Search the web for today\'s weather', 'Hey Alice', 'Good morning', 'How are you?',
            'Thank you Alice', 'What do you mean?', 'Can you clarify?', 'Explain that again',
            '', '   ', 'purple elephants danced quietly', 'xX_random-text_9000 vX',
            null, undefined, 42, {}, [], true
        ];
        for (const request of requests) {
            const result = detectIntent(request);
            assertContract(result, JSON.stringify(request) ?? String(request));
        }

        // Frozen and fresh per call — mutable-looking abuse cannot corrupt results.
        const first = detectIntent('Open YouTube');
        const second = detectIntent('Open YouTube');
        assert.notStrictEqual(first, second, 'each call returns a fresh object');
        assert.deepEqual(first, second, 'detection is deterministic');
        assert.throws(() => { first.intent = 'unknown'; }, TypeError);
        assert.throws(() => { first.confidence = 0.99; }, TypeError);
        assert.throws(() => { delete first.intent; }, TypeError);
        assert.equal(JSON.stringify(detectIntent('Open YouTube')),
            JSON.stringify(detectIntent('Open YouTube')), 'same input → same JSON output');

        // Exported constants mirror the allowed values and are frozen.
        assert.deepEqual([...DETECTED_INTENTS], ALLOWED_INTENTS);
        assert.deepEqual([...DETECTION_CONFIDENCES], ALLOWED_CONFIDENCES);
        assert.equal(Object.isFrozen(DETECTED_INTENTS), true);
        assert.equal(Object.isFrozen(DETECTION_CONFIDENCES), true);

        // Confidence is qualitative only — never a number, never a percent.
        for (const request of requests) {
            const { confidence } = detectIntent(request);
            assert.notEqual(typeof confidence, 'number');
            assert.ok(!/%|\d/.test(confidence), `confidence must be non-numeric: ${confidence}`);
        }
        // Obvious match → high; ambiguous/no match → low.
        assert.equal(detectIntent('Open YouTube').confidence, 'high');
        assert.equal(detectIntent('zzz ambiguous zz').confidence, 'low');
        assert.equal(detectIntent('zzz ambiguous zz').intent, 'unknown');
    });

    // --- Determinism & purity ------------------------------------------------
    test('detection is pure, deterministic, and side-effect free', () => {
        // Same input always yields the same output.
        for (const request of ['What is photosynthesis?', 'Open YouTube', 'Hey Alice', '']) {
            const runs = Array.from({ length: 5 }, () => detectIntent(request));
            for (const run of runs) {
                assert.deepEqual(run, runs[0], `non-deterministic output for ${request}`);
            }
        }
        // Input is never mutated.
        const input = '  Open   YouTube  ';
        const snapshot = String(input);
        detectIntent(input);
        assert.equal(input, snapshot, 'input must not be mutated');
    });

    // --- Q. No execution / no skills / no permissions / no agent ------------
    test('Q. the detector never touches skills, permissions, or the agent', async () => {
        const source = await readFile(new URL('../js/ai/intentDetector.js', import.meta.url), 'utf8');
        // Scan executable code only — boundary documentation may name the
        // systems the detector must stay independent of.
        const code = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        for (const forbidden of [
            'skillManager', 'executeByName', 'executePlan', 'permissions',
            'grantPermissions', 'gate(', 'agent', 'aiBrain', 'gateway',
            'tts', 'stt', 'wakeWord', 'detectEmotion', 'sentiment',
            'embedding', 'probabilit', 'confidenceScore', 'Math.random'
        ]) {
            assert.ok(!code.includes(forbidden),
                `intentDetector code must not reference "${forbidden}"`);
        }
        // Calling the detector only returns data — the module exports just
        // the pure function and its two frozen constant tables.
        const exports = await import('../js/ai/intentDetector.js');
        assert.deepEqual(Object.keys(exports).sort(),
            ['DETECTED_INTENTS', 'DETECTION_CONFIDENCES', 'detectIntent']);
        assert.equal(typeof exports.detectIntent, 'function');
        assert.equal(Array.isArray(exports.DETECTED_INTENTS), true);
        assert.equal(Array.isArray(exports.DETECTION_CONFIDENCES), true);
    });
});

// ---------------------------------------------------------------------------
// Part 8F: contextual second pass — an emotional/contextual preface no longer
// hides the user's actual request. Uses only the existing helpers above, the
// pure detector module, and Node built-ins. No network, no skills, no AI.
// ---------------------------------------------------------------------------
describe('Part 8F contextual intent detection (second pass)', () => {
    // --- A. Existing behavior remains unchanged ------------------------------
    test('A. direct-prefix behavior is unchanged', () => {
        expectIntent('What is photosynthesis?', 'information');
        expectIntent('Calculate 2 + 2', 'action');
        expectIntent('Hello Alice', 'conversation');
        expectIntent('Can you clarify?', 'clarification');
        expectIntent('purple elephants danced quietly', 'unknown', 'low');
        // A few more direct anchors for stability.
        expectIntent('Open YouTube', 'action');
        expectIntent('Explain quantum computing', 'information');
        expectIntent('Tell me about black holes', 'information');
        expectIntent('What do you mean?', 'clarification');
    });

    // --- B. New contextual-prefix cases (the Part 8F MUSTs) ------------------
    test('B. emotional preface no longer hides the request', () => {
        expectIntent("I'm frustrated. What is photosynthesis?", 'information');
        expectIntent("I'm sad. Calculate 25% of 800.", 'action');
        expectIntent("I'm bored. Tell me one interesting fact.", 'information');
    });

    // --- C. Additional sentence-boundary cases -------------------------------
    test('C. further boundaries and bare content requests', () => {
        expectIntent("I'm confused. Explain quantum computing.", 'information');
        expectIntent("I'm nervous. Open YouTube.", 'action');
        // Exclamation and question boundaries behave like periods.
        expectIntent("I'm frustrated! What is photosynthesis?", 'information');
        expectIntent("I'm nervous! Open YouTube.", 'action');
        // A filler segment between preface and request is still found.
        expectIntent("I'm sad. Hmm. Open YouTube.", 'action');
        // Case and whitespace are normalized before segment matching.
        expectIntent("I'M BORED. TELL ME ONE INTERESTING FACT.", 'information');
        expectIntent("I'm frustrated.   What   is photosynthesis?  ", 'information');
        // Bare content requests are information too (same narrow prefixes).
        expectIntent('Tell me one interesting fact.', 'information');
        expectIntent('Tell me a joke', 'information');
        expectIntent('Tell me an interesting story', 'information');
        expectIntent('Tell me some facts', 'information');
        expectIntent('Tell me something interesting', 'information');
    });

    // --- D. False-positive protection ----------------------------------------
    test('D. intent-looking words inside a clause do not over-classify', () => {
        // Required guards: no sentence boundary, so no second segment starts
        // with an intent prefix — the isolated word must not fire.
        expectIntent("I don't know what happened.", 'unknown', 'low');
        expectIntent("I'm frustrated because you calculate things differently.", 'unknown', 'low');
        expectIntent('Tell me why you think that.', 'unknown', 'low');
        // Bare "tell me" plus reasoning/opinion wording stays unknown.
        expectIntent('Tell me how you feel about that.', 'unknown', 'low');
        expectIntent('Tell me what you think.', 'unknown', 'low');
        // A trailing segment that merely contains an intent word (not at its
        // start) must not fire either.
        expectIntent("I'm frustrated. I don't know what happened.", 'unknown', 'low');
        expectIntent("I'm sad. Please don't calculate anything yet.", 'unknown', 'low');
        expectIntent("I'm bored. Tell me why you think that.", 'unknown', 'low');
        expectIntent('I was wondering what time it is.', 'unknown', 'low');
        expectIntent("I'm happy because you explain things well.", 'unknown', 'low');
        expectIntent('The calculator is on the table.', 'unknown', 'low');
        // Documented limits: commas are not sentence boundaries, and only a
        // limited set of trailing segments is inspected.
        expectIntent("I'm sad, what is photosynthesis?", 'unknown', 'low');
        expectIntent('Tell me, one interesting fact.', 'unknown', 'low');
    });

    // --- E. Precedence is preserved ------------------------------------------
    test('E. clarification still wins, action still beats information', () => {
        // Clarification wins even after a preface (global phrase, highest).
        expectIntent("I'm frustrated. What do you mean?", 'clarification');
        expectIntent("I'm sad. Can you clarify?", 'clarification');
        expectIntent('Start over and explain that again', 'clarification');
        // Action prefix at a segment start beats informational wording inside.
        expectIntent("I'm nervous. Search the web for what is photosynthesis", 'action');
        expectIntent("I'm sad. Calculate why the sky is blue", 'action');
        expectIntent('Search the web for what is photosynthesis', 'action');
        // Direct-prefix matches still win over any later segment.
        expectIntent('What is photosynthesis? Open YouTube.', 'information');
        expectIntent('Open YouTube. What is photosynthesis?', 'action');
    });

    // --- Contract, purity, and determinism for second-pass results -----------
    test('second-pass results keep the exact contract and purity', () => {
        const requests = [
            "I'm frustrated. What is photosynthesis?",
            "I'm sad. Calculate 25% of 800.",
            "I'm bored. Tell me one interesting fact.",
            "I'm confused. Explain quantum computing.",
            "I'm nervous. Open YouTube.",
            "I don't know what happened.",
            "I'm frustrated because you calculate things differently.",
            'Tell me why you think that.'
        ];
        for (const request of requests) {
            assertContract(detectIntent(request), JSON.stringify(request));
        }
        // Matched → high; no reliable match → low/unknown.
        assert.equal(detectIntent("I'm bored. Tell me one interesting fact.").confidence, 'high');
        assert.deepEqual(detectIntent("I'm frustrated because you calculate things differently."),
            { intent: 'unknown', confidence: 'low' });

        // Frozen, fresh, deterministic, and non-mutating.
        const input = "I'm bored. Tell me one interesting fact.";
        const first = detectIntent(input);
        const second = detectIntent(input);
        assert.notStrictEqual(first, second, 'each call returns a fresh object');
        assert.deepEqual(first, second, 'detection is deterministic');
        assert.throws(() => { first.intent = 'unknown'; }, TypeError);
        assert.equal(input, "I'm bored. Tell me one interesting fact.", 'input must not be mutated');

        // Invalid input still falls back conservatively and never throws.
        for (const invalid of [null, undefined, 42, true, {}, [], Symbol('x')]) {
            expectIntent(invalid, 'unknown', 'low');
        }
    });
});
