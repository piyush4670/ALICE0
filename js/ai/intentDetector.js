/**
 * Part 7C: deterministic intent detection v1 — a THIN INTELLIGENCE SLICE.
 * Part 8F: contextual second pass — an emotional/contextual preface no
 * longer hides the user's actual request.
 *
 * detectIntent(request) classifies an obvious user request into one of
 * five transparent categories and reports a qualitative confidence.
 *
 * Boundaries — this module is pure classification only:
 *   - No LLM / AI gateway / embeddings / vector search / machine
 *     learning / probabilistic scoring / numeric confidence values.
 *   - No emotion detection, no personality-mode selection, no sensitive
 *     personal-information inference.
 *   - No skills, permissions, agent, UI/STT/TTS, or wake-word coupling;
 *     detection never executes anything and never grants permissions.
 *   - No network, memory, state, or I/O of any kind; zero imports.
 *
 * Rules are deliberately small and explicit:
 *   - normalize (trim, lowercase, collapse whitespace, unify quotes)
 *   - phrase/prefix matching with word boundaries (no substring hits
 *     inside unrelated words like "which" or "Ohio")
 *   - precedence: clarification → action → information → conversation
 *     → unknown, so "What do you mean?" stays clarification even though
 *     it starts with "what", and "Search the web for ..." stays action
 *     even though it contains informational wording.
 *   - Part 8F second pass: when the beginning yields no high-confidence
 *     intent, inspect segment starts after common sentence boundaries
 *     ('.', '!', '?') in order, with the same precedence per segment.
 *     Prefix checks stay segment-start only — intent-looking words
 *     inside a clause ("because you calculate ...", "what happened"
 *     without a leading boundary) never fire. Only a limited set of
 *     trailing segments is inspected; commas, semicolons, and colons
 *     are not boundaries.
 *   - Part 8F narrow content-request forms ("tell me a/an/one/some/
 *     something ...") so "Tell me one interesting fact." is information
 *     while bare "tell me" stays unknown ("Tell me why you think that."
 *     is not classified as information).
 *
 * Confidence is qualitative only: an obvious match is 'high'; an
 * ambiguous or unmatched request is 'unknown' with 'low'. Every result
 * is a fresh frozen plain object, matching the InteractionContext
 * context-contract conventions. Invalid input and internal failures
 * fall back to { intent: 'unknown', confidence: 'low' } and never throw.
 */

// --- Allowed output values --------------------------------------------------

export const DETECTED_INTENTS = Object.freeze([
    'information',
    'action',
    'conversation',
    'clarification',
    'unknown'
]);

export const DETECTION_CONFIDENCES = Object.freeze(['high', 'low']);

// --- Explicit rule tables (small and conservative) ---------------------------

// Checked first: a clarification request must win over any "what"/"explain"
// wording it happens to contain.
const CLARIFICATION_PHRASES = Object.freeze([
    'what do you mean',
    'what does that mean',
    'explain that again',
    'explain again',
    "i don't understand",
    "i didn't understand",
    'can you clarify',
    'please clarify'
]);

// Obvious imperative/request forms, matched as prefixes only.
const ACTION_PREFIXES = Object.freeze([
    'open',
    'launch',
    'start',
    'set',
    'create',
    'delete',
    'search',
    'calculate',
    'remind',
    'play',
    'navigate',
    'go to'
]);

// Obvious informational/question forms, matched as prefixes only.
const INFORMATION_PREFIXES = Object.freeze([
    'what',
    'why',
    'when',
    'where',
    'who',
    'explain',
    'tell me about',
    // Part 8F: narrow content-request forms — "tell me" plus a determiner
    // that asks for an item ("a joke", "an explanation", "one fact",
    // "some examples", "something interesting"). Bare "tell me" is
    // deliberately not a prefix, so "Tell me why you think that." stays
    // unknown.
    'tell me a',
    'tell me an',
    'tell me one',
    'tell me some',
    'tell me something',
    'how does',
    'how do',
    'how is'
]);

// Obvious conversational/greeting forms, matched as word-bounded phrases.
const CONVERSATION_PHRASES = Object.freeze([
    'hi',
    'hello',
    'hey',
    'good morning',
    'good evening',
    'how are you',
    'thank you',
    'thanks',
    'bye',
    'goodbye'
]);

// --- Small helpers (pure, deterministic) -------------------------------------

function fallbackResult() {
    // A fresh frozen object per call, like the InteractionContext factory.
    return Object.freeze({ intent: 'unknown', confidence: 'low' });
}

function normalize(request) {
    if (typeof request !== 'string') return '';
    return request
        .replace(/[\u2018\u2019]/g, "'") // curly quotes → straight
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-bounded phrase match: never fires inside an unrelated word. */
function phraseMatch(normalized, phrase) {
    return new RegExp(`\\b${escapeRegExp(phrase)}\\b`).test(normalized);
}

/** Prefix match with a boundary check: "opening"/"whatsoever" do not match. */
function prefixMatch(normalized, prefix) {
    if (!normalized.startsWith(prefix)) return false;
    const next = normalized.charAt(prefix.length);
    return next === '' || !/[a-z0-9]/i.test(next);
}

function matchesAnyPhrase(normalized, phrases) {
    return phrases.some((phrase) => phraseMatch(normalized, phrase));
}

function matchesAnyPrefix(normalized, prefixes) {
    return prefixes.some((prefix) => prefixMatch(normalized, prefix));
}

// --- Part 8F second pass (small, deterministic) -------------------------------

// First segment plus up to three trailing segments after boundaries.
const SECOND_PASS_MAX_SEGMENTS = 4;

/**
 * Split normalized text on common sentence boundaries ('.', '!', '?').
 * Returns up to SECOND_PASS_MAX_SEGMENTS non-empty trimmed segments in
 * order. Commas, semicolons, and colons are not boundaries, so subordinate
 * clauses never become segments.
 */
function splitSegments(normalized) {
    const raw = normalized.split(/[.!?]+/);
    const segments = [];
    for (const part of raw) {
        const trimmed = part.trim();
        if (trimmed !== '') {
            segments.push(trimmed);
            if (segments.length >= SECOND_PASS_MAX_SEGMENTS) break;
        }
    }
    return segments;
}

// --- Detector ----------------------------------------------------------------

/**
 * Deterministically detect the intent of an arbitrary user request.
 *
 * Pure and side-effect free: the same input always yields an equal,
 * freshly frozen result. Never throws — invalid input and internal
 * failures fall back to { intent: 'unknown', confidence: 'low' }.
 *
 * Part 8F: the direct-prefix rules above run first and keep their
 * precedence; only when they yield no high-confidence intent, a limited
 * second pass inspects segment starts after sentence boundaries with the
 * same clarification → action → information → conversation order.
 *
 * @param {*} request Arbitrary user request (expected: string).
 * @returns {{ intent: string, confidence: string }} Frozen result;
 *   intent ∈ DETECTED_INTENTS, confidence ∈ DETECTION_CONFIDENCES.
 *   Confidence is qualitative only — never a numeric probability.
 */
export function detectIntent(request) {
    try {
        const normalized = normalize(request);
        if (normalized === '') return fallbackResult();

        // Precedence: clarification → action → information → conversation.
        if (matchesAnyPhrase(normalized, CLARIFICATION_PHRASES)) {
            return Object.freeze({ intent: 'clarification', confidence: 'high' });
        }
        if (matchesAnyPrefix(normalized, ACTION_PREFIXES)) {
            return Object.freeze({ intent: 'action', confidence: 'high' });
        }
        if (matchesAnyPrefix(normalized, INFORMATION_PREFIXES)) {
            return Object.freeze({ intent: 'information', confidence: 'high' });
        }
        if (matchesAnyPhrase(normalized, CONVERSATION_PHRASES)) {
            return Object.freeze({ intent: 'conversation', confidence: 'high' });
        }

        // Part 8F second pass: no high-confidence intent from the beginning —
        // inspect segment starts after sentence boundaries, in order, with
        // the same precedence per segment. Prefix checks stay segment-start
        // only, so intent-looking words inside a clause never fire.
        const segments = splitSegments(normalized);
        for (let i = 1; i < segments.length; i++) {
            const segment = segments[i];
            if (matchesAnyPhrase(segment, CLARIFICATION_PHRASES)) {
                return Object.freeze({ intent: 'clarification', confidence: 'high' });
            }
            if (matchesAnyPrefix(segment, ACTION_PREFIXES)) {
                return Object.freeze({ intent: 'action', confidence: 'high' });
            }
            if (matchesAnyPrefix(segment, INFORMATION_PREFIXES)) {
                return Object.freeze({ intent: 'information', confidence: 'high' });
            }
            if (matchesAnyPhrase(segment, CONVERSATION_PHRASES)) {
                return Object.freeze({ intent: 'conversation', confidence: 'high' });
            }
        }

        // Ambiguous / no obvious match.
        return fallbackResult();
    } catch {
        // Conservative fallback: never throw from intent detection.
        return fallbackResult();
    }
}
