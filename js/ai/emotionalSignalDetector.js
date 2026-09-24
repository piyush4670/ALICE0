/**
 * Part 8A: deterministic emotional-signal detection v1 — DETECTION ONLY.
 *
 * detectEmotionalSignal(request) reports an explicit emotional phrase in
 * the user's own wording. It never infers a hidden psychological or
 * emotional state, never diagnoses, and never selects a tone, personality
 * mode, response depth, or UI state. The result is interaction metadata
 * for later parts; this module does not change how ALICE responds.
 *
 * Boundaries — pure classification only:
 *   - No LLM / AI gateway / vector lookup / machine learning /
 *     weighted ranking / numeric confidence values.
 *   - No personality-mode selection, no intent classification, no
 *     response-depth selection, no sensitive personal-information inference.
 *   - No skills, permissions, agent, UI/STT/TTS, or wake-word coupling.
 *   - No network, memory, state, or I/O of any kind; no module dependencies.
 *   - No mutable global state. The same input always yields an equal,
 *     freshly frozen result. Invalid input never throws.
 *
 * Normalization is deliberately lightweight (no semantic rewriting):
 *   non-string → neutral/low, empty → neutral/low, trim, lowercase,
 *   curly apostrophes → straight apostrophes, collapse repeated whitespace.
 *
 * Matching is whole-phrase and word-bounded, so partial words never fire
 * ("happily" ≠ "happy", "madison" ≠ "mad", "wonderful" ≠ "wonder").
 *
 * PRECEDENCE (first explicit phrase wins; no scoring):
 *   frustrated → angry → sad → nervous → confused → lonely → tired
 *   → excited → happy → curious → bored → neutral
 *
 * An explicit phrase match is confidence 'high'. No match is
 * { signal: 'neutral', confidence: 'low' }.
 */

// --- Allowed output values --------------------------------------------------

export const EMOTIONAL_SIGNALS = Object.freeze([
    'neutral',
    'happy',
    'sad',
    'angry',
    'frustrated',
    'confused',
    'nervous',
    'excited',
    'tired',
    'lonely',
    'curious',
    'bored'
]);

export const DETECTION_CONFIDENCES = Object.freeze([
    'high',
    'low'
]);

// --- Explicit phrase tables, in precedence order (not export order) ---------

const SIGNAL_PHRASES = Object.freeze([
    Object.freeze(['frustrated', Object.freeze([
        'i am frustrated',
        "i'm frustrated",
        'i feel frustrated',
        "i'm feeling frustrated",
        'this is frustrating',
        "i'm getting frustrated"
    ])]),
    Object.freeze(['angry', Object.freeze([
        'i am angry',
        "i'm angry",
        'i feel angry',
        "i'm feeling angry",
        'i am mad',
        "i'm mad",
        "i'm furious"
    ])]),
    Object.freeze(['sad', Object.freeze([
        'i am sad',
        "i'm sad",
        'i feel sad',
        "i'm feeling sad",
        'i am upset',
        "i'm upset",
        'i feel down',
        "i'm feeling down"
    ])]),
    Object.freeze(['nervous', Object.freeze([
        'i am nervous',
        "i'm nervous",
        'i feel nervous',
        "i'm feeling nervous",
        'i am anxious',
        "i'm anxious",
        'i feel anxious',
        "i'm worried"
    ])]),
    Object.freeze(['confused', Object.freeze([
        'i am confused',
        "i'm confused",
        'i feel confused',
        "i'm feeling confused",
        "i don't understand",
        'i dont understand',
        "i'm lost",
        'i am lost'
    ])]),
    Object.freeze(['lonely', Object.freeze([
        'i am lonely',
        "i'm lonely",
        'i feel lonely',
        "i'm feeling lonely",
        'i feel alone',
        "i'm feeling alone"
    ])]),
    Object.freeze(['tired', Object.freeze([
        'i am tired',
        "i'm tired",
        'i feel tired',
        "i'm feeling tired",
        'i am exhausted',
        "i'm exhausted",
        'i feel exhausted'
    ])]),
    Object.freeze(['excited', Object.freeze([
        'i am excited',
        "i'm excited",
        'i feel excited',
        "i'm feeling excited",
        "i can't wait",
        'i cant wait',
        'this is exciting'
    ])]),
    Object.freeze(['happy', Object.freeze([
        'i am happy',
        "i'm happy",
        'i feel happy',
        "i'm feeling happy",
        'i am glad',
        "i'm glad",
        'i feel good',
        "i'm feeling good"
    ])]),
    Object.freeze(['curious', Object.freeze([
        'i am curious',
        "i'm curious",
        'i feel curious',
        "i'm wondering",
        'i wonder'
    ])]),
    Object.freeze(['bored', Object.freeze([
        'i am bored',
        "i'm bored",
        'i feel bored',
        "i'm feeling bored",
        "i'm so bored"
    ])])
]);

// --- Small helpers (pure, deterministic) ------------------------------------

function neutralResult() {
    return Object.freeze({ signal: 'neutral', confidence: 'low' });
}

function explicitResult(signal) {
    return Object.freeze({ signal, confidence: 'high' });
}

/**
 * Lightweight normalization only. Does not rewrite meaning, expand
 * contractions, strip negation, or coerce non-strings.
 */
function normalize(request) {
    if (typeof request !== 'string') return '';
    return request
        .trim()
        .toLowerCase()
        .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
        .replace(/\s+/g, ' ');
}

/** ASCII word char, matching a JS word boundary (\w) without regex state. */
function isWordChar(ch) {
    if (typeof ch !== 'string' || ch.length !== 1) return false;
    const code = ch.charCodeAt(0);
    return (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || code === 95;
}

/**
 * Whole-phrase match. A hit inside a longer word ("happily", "madison",
 * "wonderful") does not count. Punctuation is a boundary, so "I'm excited!"
 * still matches. The caller's string is never written.
 */
function hasPhrase(normalized, phrase) {
    if (normalized.length < phrase.length) return false;
    let from = 0;
    while (from <= normalized.length - phrase.length) {
        const index = normalized.indexOf(phrase, from);
        if (index === -1) return false;
        const before = index === 0 ? '' : normalized.charAt(index - 1);
        const afterIndex = index + phrase.length;
        const after = afterIndex >= normalized.length ? '' : normalized.charAt(afterIndex);
        if (!isWordChar(before) && !isWordChar(after)) return true;
        from = index + 1;
    }
    return false;
}

// --- Detector ----------------------------------------------------------------

/**
 * Deterministically detect an explicit emotional phrase in a user request.
 *
 * Pure and side-effect free: the same input always yields an equal, freshly
 * frozen result. Never throws — non-strings, empty input, and internal
 * failures fall back to { signal: 'neutral', confidence: 'low' }.
 *
 * @param {*} request Arbitrary user request (expected: string).
 * @returns {{ signal: string, confidence: 'high'|'low' }} Frozen result.
 *   signal ∈ EMOTIONAL_SIGNALS. Confidence is qualitative only.
 */
export function detectEmotionalSignal(request) {
    try {
        const normalized = normalize(request);
        if (normalized === '') return neutralResult();

        for (const [signal, phrases] of SIGNAL_PHRASES) {
            for (const phrase of phrases) {
                if (hasPhrase(normalized, phrase)) return explicitResult(signal);
            }
        }
        return neutralResult();
    } catch {
        return neutralResult();
    }
}
