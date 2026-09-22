/**
 * Part 2 only: interaction context foundation. No runtime integration.
 *
 * A small, dependency-free contract describing "what the current
 * interaction is understood to be", suitable for future model
 * consumption. It complements Part 1 (js/ai/aliceIdentity.js), which
 * answers "who is ALICE?". The two modules are intentionally separate:
 * the same conceptual mode/depth names are referenced here, but no part
 * of the ALICE identity is duplicated.
 *
 * Boundaries — this module is a representation/contract only:
 *   - No AI inference, no intent classification, no turn-type detection.
 *   - No emotional detection. `emotionalSignal` is a broad contextual
 *     label, not a claim that ALICE experiences human emotions.
 *   - No automatic personality-mode or response-depth selection.
 *   - No network, memory, permissions, tool, state, or microphone
 *     access; no response generation.
 *
 * All values come from explicit caller input or documented safe
 * defaults. Every exported constant is frozen, and the factory returns
 * a fresh frozen plain object on every call — shared state is never
 * reused or mutated.
 */

// --- Allowed values (future enum contracts) --------------------------------

export const INTERACTION_TURN_TYPES = Object.freeze([
    'new',
    'follow_up'
]);

export const INTERACTION_INTENTS = Object.freeze([
    'information',
    'action',
    'conversation',
    'clarification',
    'unknown'
]);

export const INTERACTION_RESPONSE_DEPTHS = Object.freeze([
    'quick',
    'explain',
    'deep'
]);

export const INTERACTION_MODES = Object.freeze([
    'soft',
    'focus',
    'playful',
    'analyst',
    'guardian',
    'teacher'
]);

// Broad contextual labels only. Never a claim that ALICE experiences
// human emotions; detection of these is not implemented here.
export const INTERACTION_EMOTIONAL_SIGNALS = Object.freeze([
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

export const INTERACTION_SOURCES = Object.freeze([
    'text',
    'voice'
]);

// --- Safe defaults ----------------------------------------------------------

export const INTERACTION_CONTEXT_DEFAULTS = Object.freeze({
    request: '',
    turnType: 'new',
    intent: 'unknown',
    responseDepth: 'quick',
    mode: null,
    emotionalSignal: 'neutral',
    source: 'text'
});

// --- Small normalizers (no detection, no inference) -------------------------

function normalizeRequest(value) {
    if (typeof value === 'string') return value.trim();
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value).trim();
    }
    return '';
}

function normalizeEnum(value, allowed, fallback) {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function normalizeMode(value) {
    return normalizeEnum(value, INTERACTION_MODES, INTERACTION_CONTEXT_DEFAULTS.mode);
}

/**
 * Create a normalized interaction context.
 *
 * Pure and deterministic: the same input always yields the same plain
 * object (fresh and frozen on every call). Unknown keys are dropped and
 * invalid enum values fall back to the documented default, so callers
 * cannot silently create arbitrary context state. Nothing is detected,
 * inferred, or selected here.
 *
 * @param {Object} [options]
 * @param {string} [options.request] Current user request.
 * @param {string} [options.turnType] 'new' | 'follow_up' (no auto-detection).
 * @param {string} [options.intent] 'information' | 'action' | 'conversation' | 'clarification' | 'unknown' (no auto-detection).
 * @param {string} [options.responseDepth] 'quick' | 'explain' | 'deep' (no auto-selection).
 * @param {string|null} [options.mode] 'soft' | 'focus' | 'playful' | 'analyst' | 'guardian' | 'teacher' | null (no auto-selection).
 * @param {string} [options.emotionalSignal] Broad contextual label from INTERACTION_EMOTIONAL_SIGNALS (no detection).
 * @param {string} [options.source] 'text' | 'voice' (no auto-detection).
 * @returns {Object} A fresh, frozen, plain interaction context.
 */
export function createInteractionContext(options = {}) {
    const input = (options !== null && typeof options === 'object') ? options : {};
    return Object.freeze({
        request: normalizeRequest(input.request),
        turnType: normalizeEnum(input.turnType, INTERACTION_TURN_TYPES, INTERACTION_CONTEXT_DEFAULTS.turnType),
        intent: normalizeEnum(input.intent, INTERACTION_INTENTS, INTERACTION_CONTEXT_DEFAULTS.intent),
        responseDepth: normalizeEnum(input.responseDepth, INTERACTION_RESPONSE_DEPTHS, INTERACTION_CONTEXT_DEFAULTS.responseDepth),
        mode: normalizeMode(input.mode),
        emotionalSignal: normalizeEnum(input.emotionalSignal, INTERACTION_EMOTIONAL_SIGNALS, INTERACTION_CONTEXT_DEFAULTS.emotionalSignal),
        source: normalizeEnum(input.source, INTERACTION_SOURCES, INTERACTION_CONTEXT_DEFAULTS.source)
    });
}
