/**
 * ALICE Request Router
 * ------------------------------------------------------------------
 * Deterministic decision: is this request an ACTION request or an ORDINARY
 * (natural-language / conversational) request?
 *
 * The route decides what happens when the AI attempt does not produce a
 * usable answer:
 *
 *   - ACTION       — the existing deterministic fallback (multi-step agent,
 *                    then single-skill execution) may run, exactly as before.
 *   - CONVERSATION — no skill or agent is ever executed on behalf of the
 *                    request. The user receives a clear, categorized
 *                    recovery answer instead.
 *
 * It does NOT grant authority. A request routed to ACTION still goes through
 * the AI plan path (validated by PlanValidator), the Agent and the Permission
 * Gateway. A request routed to CONVERSATION can still receive a direct
 * answer from the model; it simply can never be executed as a skill.
 *
 * Signals (any one selects ACTION; otherwise CONVERSATION):
 *   1. an explicit imperative/action intent from the Part 7C detector;
 *   2. a skill claim from SkillManager.matchSkill() (explicit trigger
 *      patterns only — keyword-only evidence never claims a request);
 *   3. a multi-step analysis from TaskPlanner.analyze().
 *
 * Pure with respect to the request: no state, no logging, no network.
 */
import { detectIntent } from './intentDetector.js';
import { skillManager as defaultSkillManager } from '../skillManager.js';
import { taskPlanner as defaultTaskPlanner } from '../taskPlanner.js';

export const REQUEST_ROUTE = Object.freeze({
    ACTION: 'action',
    CONVERSATION: 'conversation'
});

/**
 * @param {*} text - The raw user request
 * @param {Object} [deps] - Injectable collaborators (tests)
 * @returns {'action'|'conversation'}
 */
export function routeRequest(text, deps = {}) {
    const skills = deps.skillManager || defaultSkillManager;
    const planner = deps.taskPlanner || defaultTaskPlanner;

    const request = typeof text === 'string' ? text.trim() : '';
    if (request === '') return REQUEST_ROUTE.CONVERSATION;

    if (detectIntent(request).intent === 'action') {
        return REQUEST_ROUTE.ACTION;
    }

    try {
        if (skills.matchSkill(request)?.skill) {
            return REQUEST_ROUTE.ACTION;
        }
    } catch (e) {
        // A routing lookup must never break the request; treat as no claim.
    }

    try {
        if (planner.analyze(request)?.isMultiStep) {
            return REQUEST_ROUTE.ACTION;
        }
    } catch (e) {
        // Same rule: a planner failure is not evidence of an action.
    }

    return REQUEST_ROUTE.CONVERSATION;
}
