/**
 * Part 7D: deterministic response-depth detection v1 — a THIN INTELLIGENCE
 * SLICE.
 *
 * detectResponseDepth(request) reports how much depth the user explicitly
 * asked for, as one of three transparent values plus a qualitative
 * confidence:
 *
 *   { depth: 'quick' | 'explain' | 'deep', confidence: 'high' | 'low' }
 *
 * Boundaries — this module is pure classification only:
 *   - No LLM / AI gateway / embeddings / vector search / machine learning /
 *     probabilistic scoring / numeric confidence values.
 *   - No emotion detection, no personality-mode selection, no sensitive
 *     personal-information inference.
 *   - No skills, permissions, agent, UI/STT/TTS, or wake-word coupling;
 *     detection never executes anything and never grants permissions.
 *   - No network, memory, state, or I/O of any kind; zero imports.
 *
 * Rules are deliberately small, explicit and conservative:
 *   - normalize (non-string → empty, trim, lowercase, collapse whitespace,
 *     unify curly apostrophes)
 *   - word-bounded phrase matching, so fragments inside unrelated words
 *     never fire ("explanation" ≠ "explain", "deeply" ≠ "deep",
 *     "shortage" ≠ "short answer")
 *   - precedence: deep → explain → quick → default
 *
 * Complexity is NEVER inferred. A long, technical, or apparently difficult
 * question stays at the default depth unless the user's own wording asks
 * for more (or less). Only explicit phrasing changes the result.
 *
 * Confidence is qualitative only: an explicit phrase match is 'high'; no
 * explicit cue yields the default { depth: 'quick', confidence: 'low' } —
 * there is no 'unknown' depth value in the contract. Every result is a
 * fresh frozen plain object, matching the InteractionContext conventions.
 * Invalid input and internal failures fall back to the default and never
 * throw. The detector does not normalize InteractionContext itself; the
 * factory in js/ai/interactionContext.js remains the single normalization
 * boundary.
 */

// --- Explicit rule tables (small and conservative) ---------------------------

// Checked first: an explicit request for depth wins over any "explain" or
// "short" wording it happens to contain.
const DEEP_PHRASES = Object.freeze([
    'in detail',
    'detailed explanation',
    'explain in detail',
    'deep explanation',
    'go deep',
    'deep dive',
    'thoroughly',
    'step by step in detail',
    'with detailed examples'
]);

// Checked second: an explicit request for an explanation.
const EXPLAIN_PHRASES = Object.freeze([
    'explain',
    'explain this',
    'explain that',
    'how does this work',
    'how does it work',
    'why does this happen',
    'give me an explanation',
    'with an example',
    'give an example'
]);

// Checked last: an explicit request for brevity.
const QUICK_PHRASES = Object.freeze([
    'just the answer',
    'short answer',
    'briefly',
    'in short',
    'keep it short',
    'quick answer',
    'just tell me',
    'only the answer'
]);

// --- Small helpers (pure, deterministic) -------------------------------------

/**
 * Default result: no explicit depth cue (or unusable input). A fresh frozen
 * object per call, like the InteractionContext factory.
 */
function defaultResult() {
    return Object.freeze({ depth: 'quick', confidence: 'low' });
}

function explicitResult(depth) {
    return Object.freeze({ depth, confidence: 'high' });
}

function normalize(request) {
    if (typeof request !== 'string') return '';
    return request
        .replace(/[\u2018\u2019]/g, "'") // curly apostrophes → straight
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

function matchesAnyPhrase(normalized, phrases) {
    return phrases.some((phrase) => phraseMatch(normalized, phrase));
}

// --- Detector ----------------------------------------------------------------

/**
 * Deterministically detect the explicitly requested response depth.
 *
 * Pure and side-effect free: the same input always yields an equal, freshly
 * frozen result. Never throws — invalid input and internal failures fall
 * back to { depth: 'quick', confidence: 'low' }.
 *
 * @param {*} request Arbitrary user request (expected: string).
 * @returns {{ depth: 'quick'|'explain'|'deep', confidence: 'high'|'low' }}
 *   Frozen result. Confidence is qualitative only — never numeric.
 */
export function detectResponseDepth(request) {
    try {
        const normalized = normalize(request);
        if (normalized === '') return defaultResult();

        // Precedence: deep → explain → quick → default.
        if (matchesAnyPhrase(normalized, DEEP_PHRASES)) {
            return explicitResult('deep');
        }
        if (matchesAnyPhrase(normalized, EXPLAIN_PHRASES)) {
            return explicitResult('explain');
        }
        if (matchesAnyPhrase(normalized, QUICK_PHRASES)) {
            return explicitResult('quick');
        }

        // No explicit depth cue: never infer depth from apparent complexity.
        return defaultResult();
    } catch {
        // Conservative fallback: never throw from depth detection.
        return defaultResult();
    }
}
