/**
 * ALICE AI Outcome Classification
 * ------------------------------------------------------------------
 * Single place where AI Brain results and failures are turned into a
 * named outcome, a fixed recovery message and a content-free diagnostic.
 *
 * Why this exists: before this module, any AI failure (malformed output,
 * unreachable gateway, timeout, mock mode) silently fell through to the
 * deterministic skill path and then to a randomly chosen generic reply, so
 * a model failure looked exactly like a successful answer.
 *
 * Boundaries — this module is pure:
 *   - no network, no state, no skills, no permissions, no randomness;
 *   - it never executes anything and never grants authority;
 *   - diagnostics carry only a stage, an outcome name and a fixed error
 *     code. They never carry prompts, user text, model output or messages
 *     that could contain them.
 */
import { AIError } from './modelAdapter.js';

/**
 * Outcome categories. A successful result is either CONVERSATION (a valid
 * direct natural-language answer) or PLAN (a validated structured action
 * plan). Every other value is a non-success outcome.
 */
export const AI_OUTCOME = Object.freeze({
    CONVERSATION: 'conversation',
    PLAN: 'plan',
    INVALID_OUTPUT: 'invalid_output',
    PROVIDER_UNAVAILABLE: 'provider_unavailable',
    TIMEOUT: 'timeout',
    CANCELLED: 'cancelled',
    DISABLED: 'disabled',
    OFFLINE: 'offline',
    INVALID_REQUEST: 'invalid_request',
    INTERNAL: 'internal'
});

/** Map from the adapter error hierarchy codes to outcome categories. */
const ERROR_CODE_OUTCOMES = Object.freeze({
    AI_TIMEOUT: AI_OUTCOME.TIMEOUT,
    AI_CANCELLED: AI_OUTCOME.CANCELLED,
    AI_VALIDATION: AI_OUTCOME.INVALID_OUTPUT,
    AI_PROVIDER: AI_OUTCOME.PROVIDER_UNAVAILABLE
});

/**
 * Classify a thrown error into an outcome category.
 * Errors that are not part of the AI error hierarchy are INTERNAL: they are
 * local programming or runtime faults, not model or provider faults.
 *
 * @param {*} err
 * @returns {{ kind: string, code: string }}
 */
export function classifyAiError(err) {
    if (err instanceof AIError) {
        const kind = ERROR_CODE_OUTCOMES[err.code];
        if (kind) return { kind, code: err.code };
        return { kind: AI_OUTCOME.INTERNAL, code: err.code || 'AI_ERROR' };
    }
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        return { kind: AI_OUTCOME.CANCELLED, code: 'AI_CANCELLED' };
    }
    return { kind: AI_OUTCOME.INTERNAL, code: 'INTERNAL' };
}

/**
 * Fixed, user-facing recovery text for each non-success outcome. Chosen by
 * outcome only — never random, never keyword-driven, and never one of the
 * generic "help" replies.
 */
const FALLBACK_RESPONSES = Object.freeze({
    [AI_OUTCOME.PROVIDER_UNAVAILABLE]:
        "I couldn't reach my AI model through the local ALICE AI gateway, so I can't answer that right now. " +
        'Check that the gateway is running, then ask again.',
    [AI_OUTCOME.TIMEOUT]:
        'My AI model took too long to respond, so I did not get an answer. Please try again, or ask a shorter question.',
    [AI_OUTCOME.INVALID_OUTPUT]:
        "My AI model returned a reply I couldn't safely use, so I did not act on it. Please try rephrasing your request.",
    [AI_OUTCOME.OFFLINE]:
        "I'm running in offline mode without a live AI model, so I can't answer general questions yet. " +
        'I can still run my built-in skills, such as calculations, reminders, notes, web search, and the date and time.',
    [AI_OUTCOME.DISABLED]:
        'AI answers are turned off, so I can only run my built-in skills right now, such as calculations, ' +
        'reminders, notes, web search, and the date and time.',
    [AI_OUTCOME.CANCELLED]:
        'Okay, I stopped that request. Nothing was changed.',
    [AI_OUTCOME.INVALID_REQUEST]:
        'Please give me a request or a question.',
    [AI_OUTCOME.INTERNAL]:
        'Something went wrong while I was preparing a response. Please try again.'
});

/**
 * @param {string} kind - An AI_OUTCOME value
 * @returns {string} Fixed recovery text (INTERNAL text for unknown kinds)
 */
export function fallbackResponseFor(kind) {
    return Object.prototype.hasOwnProperty.call(FALLBACK_RESPONSES, kind)
        ? FALLBACK_RESPONSES[kind]
        : FALLBACK_RESPONSES[AI_OUTCOME.INTERNAL];
}

/** Keep diagnostic tokens short and restricted to a safe identifier charset. */
function diagnosticToken(value) {
    const cleaned = String(value ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
    return cleaned || null;
}

/**
 * Build a single content-free diagnostic line for the activity log. It names
 * the failed stage, the outcome category and (optionally) a fixed error code.
 * It never includes prompts, user text, model output or provider messages.
 *
 * @param {{ stage?: string, kind?: string, code?: string }} info
 * @returns {string}
 */
export function formatAiDiagnostic({ label = 'AI Brain diagnostic', stage = null, kind = null, code = null } = {}) {
    const parts = [`stage=${diagnosticToken(stage) || 'unknown'}`, `outcome=${diagnosticToken(kind) || 'unknown'}`];
    const safeCode = diagnosticToken(code);
    if (safeCode) parts.push(`code=${safeCode}`);
    const safeLabel = String(label).replace(/[^A-Za-z0-9 ]/g, '').slice(0, 60) || 'AI Brain diagnostic';
    return `${safeLabel}: ${parts.join(' ')}`;
}

/**
 * Tag an error with the pipeline stage where it occurred. The tag is a plain
 * non-enumerable property so it never changes the error's message or shape.
 *
 * @param {*} err
 * @param {string} stage
 * @returns {*} The same error object
 */
export function tagAiStage(err, stage) {
    if (err && typeof err === 'object' && !Object.prototype.hasOwnProperty.call(err, 'aiStage')) {
        Object.defineProperty(err, 'aiStage', { value: stage, enumerable: false, configurable: true });
    }
    return err;
}
