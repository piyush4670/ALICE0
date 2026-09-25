/**
 * ALICE Part 8C — Deterministic Emotional Response Guidance Contract.
 *
 * getEmotionalResponseGuidance(emotionalSignal) translates an ALREADY
 * normalized InteractionContext.emotionalSignal (Part 8A/Part 2) into a
 * small, fixed set of communication guidelines for the AI model:
 *
 *   emotionalSignal → response guidance → ContextBuilder → AI model
 *
 * It is a translation table, not an interpreter. Nothing is detected,
 * classified, scored, or inferred here: the incoming value must already be
 * one of the documented signal labels, and anything else falls back to the
 * neutral guidance. The same input always yields an equal, freshly frozen
 * guidance object.
 *
 * Boundaries — this module is a static contract only:
 *   - No emotion generation and no claim that ALICE experiences feelings.
 *   - No psychological, medical, or mental-state inference or diagnosis.
 *   - No sentiment analysis, no emotion classification, no new signals,
 *     no detection precedence, no confidence values, no scoring.
 *   - No LLM / AI gateway / embeddings / ML / network / memory / state /
 *     I/O; zero imports and zero dependencies.
 *   - No response generation, no hardcoded emotional replies, no tone
 *     selection outside the prompt, no skills, agent, permissions, UI,
 *     voice, memory, or runtime behaviour coupling.
 *
 * The guidance is deliberately simple and non-prescriptive: it describes
 * how to phrase a reply (tone, patience, clarity, brevity) and never what
 * to answer. Every guidance object also carries the safety boundaries
 * below, so the contract travels with the guidance wherever it is read.
 *
 * Only exact, already-normalized signal values are recognized
 * ('neutral', 'happy', ... — lowercase, no surrounding whitespace), which
 * matches the single normalization boundary in js/ai/interactionContext.js.
 * Unknown, malformed, or non-string input never throws and never echoes the
 * caller's text: it falls back to { signal: 'neutral', fallbackApplied: true }.
 */

// --- Guidance signal contract ------------------------------------------------

/**
 * Signals this contract can translate. Mirrors
 * INTERACTION_EMOTIONAL_SIGNALS (Part 2) exactly — this module never adds,
 * removes, or reorders a signal, and never changes detection precedence.
 */
export const GUIDANCE_SIGNALS = Object.freeze([
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

/** Signal used for unknown, invalid, or non-string input. */
export const GUIDANCE_FALLBACK_SIGNAL = 'neutral';

/**
 * Safety boundaries that always accompany the guidance. These are hard
 * limits on communication, not stylistic preferences.
 */
export const EMOTIONAL_RESPONSE_SAFETY_BOUNDARIES = Object.freeze([
    'Never claim or imply that ALICE experiences human emotions.',
    "Never diagnose or assess the user's mental or medical condition.",
    'Never manipulate, guilt, threaten, shame, or pressure the user.',
    'Never encourage emotional dependency on ALICE.',
    "Never override the user's autonomy, choices, or instructions.",
    'Never override safety, permission, validation, or confirmation boundaries.',
    "Never treat the supplied signal as certainty about the user's internal state."
]);

/**
 * Scope statement attached to every guidance object: the guidance shapes
 * wording only and can never override the user's actual request.
 */
export const EMOTIONAL_RESPONSE_GUIDANCE_SCOPE =
    "Communication guidance only: it shapes wording and tone, and never overrides the user's request, "
    + 'safety or permission boundaries, or user autonomy.';

// --- Fixed guidance table ----------------------------------------------------
//
// One frozen entry per signal. Each entry lists a short tone label and a
// small number of plain communication guidelines — no answers, no scripts,
// no claims about the user, and no instructions that could outrank a request.

const GUIDANCE_BY_SIGNAL = new Map([
    ['neutral', Object.freeze({
        tone: 'normal conversational tone',
        guidance: Object.freeze([
            'Use a normal conversational tone.',
            'Apply no special emotional framing.',
            'Do not assume, guess, or invent an emotional state.'
        ])
    })],
    ['happy', Object.freeze({
        tone: 'warm and lightly enthusiastic',
        guidance: Object.freeze([
            'Stay warm and lightly enthusiastic.',
            'Acknowledge the positive tone when appropriate.',
            'Do not overstate the situation or exaggerate.'
        ])
    })],
    ['sad', Object.freeze({
        tone: 'gentle and patient',
        guidance: Object.freeze([
            'Stay gentle and patient.',
            "Acknowledge the user's expressed feeling when relevant.",
            'Avoid forced cheerfulness.'
        ])
    })],
    ['angry', Object.freeze({
        tone: 'calm and respectful',
        guidance: Object.freeze([
            'Stay calm and respectful.',
            'Avoid escalating language.',
            'Focus on understanding the actual request.'
        ])
    })],
    ['frustrated', Object.freeze({
        tone: 'patient and solution-focused',
        guidance: Object.freeze([
            'Stay patient and solution-focused.',
            'Reduce unnecessary complexity.',
            'Avoid blaming the user.'
        ])
    })],
    ['confused', Object.freeze({
        tone: 'clear and simple',
        guidance: Object.freeze([
            'Clarify instead of restating the same explanation.',
            'Explain from a simpler starting point.',
            'Avoid assuming prior understanding.'
        ])
    })],
    ['nervous', Object.freeze({
        tone: 'calm and reassuring',
        guidance: Object.freeze([
            'Stay calm and reassuring.',
            'Explain clearly and in order.',
            'Avoid unnecessary alarm.'
        ])
    })],
    ['excited', Object.freeze({
        tone: 'enthusiastic but grounded',
        guidance: Object.freeze([
            'Allow some enthusiasm.',
            'Remain clear and grounded.'
        ])
    })],
    ['tired', Object.freeze({
        tone: 'concise and easy to follow',
        guidance: Object.freeze([
            'Keep the reply concise and easy to follow.',
            'Avoid unnecessary verbosity.'
        ])
    })],
    ['lonely', Object.freeze({
        tone: 'warm and conversational',
        guidance: Object.freeze([
            'Stay warm and conversational.',
            'Be supportive without pretending to be human.',
            'Do not encourage emotional dependency.'
        ])
    })],
    ['curious', Object.freeze({
        tone: 'encouraging and clear',
        guidance: Object.freeze([
            'Encourage exploration of the topic.',
            'Explain clearly.',
            'Invite a useful follow-up when appropriate.'
        ])
    })],
    ['bored', Object.freeze({
        tone: 'engaging where appropriate',
        guidance: Object.freeze([
            'Make the response engaging when appropriate.',
            'Avoid unnecessary filler.'
        ])
    })]
]);

// --- Guidance ----------------------------------------------------------------

/**
 * Translate an already-normalized emotionalSignal into deterministic
 * communication guidance.
 *
 * Pure, synchronous, and side-effect free: the same input always yields an
 * equal, freshly frozen plain object, and no object is ever shared between
 * calls. Never throws — unknown, malformed, or non-string input falls back
 * to the neutral guidance and the caller's value is never echoed back.
 *
 * @param {*} emotionalSignal Expected: an already-normalized value from
 *   GUIDANCE_SIGNALS (typically InteractionContext.emotionalSignal).
 * @returns {Object} Frozen guidance:
 *   {
 *     signal: string,               // resolved signal actually used
 *     isRecognizedSignal: boolean,  // false only when the fallback applied
 *     fallbackApplied: boolean,
 *     tone: string,                 // short communication-tone label
 *     guidance: string[],           // communication guidelines (never commands)
 *     safety: string[],             // safety boundaries, always present
 *     scope: string                 // guidance never overrides the request
 *   }
 */
export function getEmotionalResponseGuidance(emotionalSignal) {
    const isRecognizedSignal = typeof emotionalSignal === 'string'
        && GUIDANCE_BY_SIGNAL.has(emotionalSignal);
    const entry = isRecognizedSignal
        ? GUIDANCE_BY_SIGNAL.get(emotionalSignal)
        : GUIDANCE_BY_SIGNAL.get(GUIDANCE_FALLBACK_SIGNAL);

    return Object.freeze({
        signal: isRecognizedSignal ? emotionalSignal : GUIDANCE_FALLBACK_SIGNAL,
        isRecognizedSignal,
        fallbackApplied: !isRecognizedSignal,
        tone: entry.tone,
        // Fresh copies every call: callers can never mutate a shared table.
        guidance: Object.freeze(entry.guidance.slice()),
        safety: Object.freeze(EMOTIONAL_RESPONSE_SAFETY_BOUNDARIES.slice()),
        scope: EMOTIONAL_RESPONSE_GUIDANCE_SCOPE
    });
}
