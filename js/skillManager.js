/**
 * ALICE Skill Manager
 * Routes user requests to appropriate skills.
 * Part 5: skills are validated plugins with an optional manifest that
 * declares name, description, permissions, risk, and error handling.
 * Skills can be individually enabled/disabled by the user.
 * Part 10.1: routing is confidence-gated — only a declared pattern match can
 * claim a request; weak keyword-only evidence and equally-ranked (ambiguous)
 * matches are reported and declined instead of guessed (see the routing
 * confidence section below).
 */
import { state } from './state.js';
import { permissions } from './permissions.js';
import { calculator } from './skills/calculator.js';
import { websearch } from './skills/websearch.js';
import { notes } from './skills/notes.js';
import { reminders } from './skills/reminders.js';
import { datetime } from './skills/datetime.js';
import { files } from './skills/files.js';
import { reader } from './skills/reader.js';
import { memorySkill } from './skills/memory.js';
import { vision } from './skills/vision.js';
import { browserSkill } from './skills/browser.js';
import { dev } from './skills/dev.js';
import { iot } from './skills/iot.js';

// ---------------------------------------------------------------------------
// Part 10.1 — deterministic routing confidence
//
// Routing evidence comes in exactly two tiers:
//
//   pattern — one of the skill's own declared trigger patterns matched. This
//             is the skill's explicit contract and the only evidence that can
//             claim a request.
//   keyword — only the legacy fallback keyword table matched (0.2 per hit,
//             capped at 0.9). Keyword evidence is reported in the routing
//             decision but NEVER claims a request on its own.
//
// 0.3 (the historical `matchSkill` threshold) survives only as the confidence
// floor at which weak keyword evidence becomes *meaningful* — the decision is
// then reported as `weak`/`ambiguous` instead of `none`. It is no longer
// sufficient to route.
// ---------------------------------------------------------------------------

/** Confidence floor for keyword-only evidence (legacy 0.3 threshold). */
const ROUTING_KEYWORD_FLOOR = 0.3;

/** Tolerance used when comparing two confidence scores for equality. */
const ROUTING_EPSILON = 1e-9;

/**
 * Fallback keyword table (Part 10.1: weak evidence — never claims a request
 * on its own, but it is still reported in the routing decision).
 */
const ROUTING_KEYWORDS = {
    calculator: ['calculate', 'math', 'number', 'add', 'subtract', 'multiply', 'divide', '+', '-', '*', '/', '=', 'percent'],
    websearch: ['search', 'google', 'find', 'information', 'what is', 'who is', 'where is', 'latest'],
    notes: ['note', 'write down', 'remember this'],
    reminders: ['remind', 'reminder', 'task', 'todo', 'alarm'],
    datetime: ['time', 'date', 'day', 'month', 'year', 'today', 'tomorrow'],
    files: ['file', 'document', 'read', 'open', 'save'],
    reader: ['read aloud', 'summarize', 'extract'],
    memory: ['remember', 'my', 'forget', 'recall'],
    vision: ['image', 'picture', 'photo', 'screenshot', 'diagram', 'see', 'look at', 'vision'],
    browser: ['browser', 'website', 'webpage', 'web page', 'open site', 'navigate', 'open url', 'visit'],
    dev: ['code', 'debug', 'programming', 'script', 'error', 'bug', 'fix', 'function', 'javascript', 'project', 'lint', 'scaffold'],
    iot: ['light', 'device', 'iot', 'sensor', 'smart home', 'thermostat', 'switch', 'turn on', 'turn off']
};

/**
 * Framing/function words. A pattern that consumed only these words
 * (websearch's `/what is /`) is weaker evidence than one that consumed real
 * content (the calculator's `10 plus 5`), so specificity counts the complete
 * non-framing tokens a match consumed.
 */
const ROUTING_FRAMING_WORDS = new Set([
    'a', 'an', 'and', 'are', 'at', 'be', 'by', 'can', 'could', 'did', 'do',
    'does', 'for', 'from', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on',
    'or', 'please', 'the', 'this', 'that', 'those', 'to', 'was', 'were',
    'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your'
]);

class SkillManager {
    constructor() {
        this._skills = new Map();
        this._lastSkill = null;
        this._executionHistory = [];
        this._enabled = new Map(); // name -> boolean
        
        this._registerSkills();
    }

    /**
     * Register all available skills
     */
    _registerSkills() {
        // Core skills
        this.register(datetime);
        this.register(calculator);
        this.register(websearch);
        this.register(notes);
        this.register(reminders);
        this.register(files);
        this.register(reader);
        this.register(memorySkill);
        // Part 5 skills
        this.register(vision);
        this.register(browserSkill);
        this.register(dev);
        this.register(iot);
        
        state.logActivity(`Registered ${this._skills.size} skills`, 'info');
    }

    /**
     * Validate a skill plugin manifest. A skill must define at least a name,
     * description, patterns, and an execute() function. Optional Part 5
     * manifest fields (permissions, risk, inputs, actions, output, onError)
     * are validated when present.
     * Returns { valid, errors }.
     */
    validateSkill(skill) {
        const errors = [];
        if (!skill || typeof skill !== 'object') {
            return { valid: false, errors: ['skill is not an object'] };
        }
        if (!skill.name || typeof skill.name !== 'string') errors.push('missing name');
        if (!skill.description || typeof skill.description !== 'string') errors.push('missing description');
        if (!Array.isArray(skill.patterns) || skill.patterns.length === 0) errors.push('patterns must be a non-empty array');
        if (typeof skill.execute !== 'function') errors.push('missing execute()');

        // Optional manifest fields
        if (skill.permissions !== undefined && !Array.isArray(skill.permissions)) {
            errors.push('permissions must be an array');
        }
        if (skill.risk !== undefined && !['safe', 'medium', 'sensitive'].includes(skill.risk)) {
            errors.push('risk must be one of: safe, medium, sensitive');
        }
        if (skill.inputs !== undefined && !Array.isArray(skill.inputs)) {
            errors.push('inputs must be an array');
        }
        // Action-level permission metadata (used by the permission gateway):
        // sensitiveActions — input patterns for sub-actions requiring
        // confirmation; safeActions — read-only exemptions for skills whose
        // overall risk is 'sensitive'
        if (skill.sensitiveActions !== undefined && !this._isValidActionList(skill.sensitiveActions)) {
            errors.push('sensitiveActions must be an array of { pattern } entries');
        }
        if (skill.safeActions !== undefined && !this._isValidActionList(skill.safeActions)) {
            errors.push('safeActions must be an array of { pattern } entries');
        }
        return { valid: errors.length === 0, errors };
    }

    /**
     * Action metadata lists must be arrays of objects carrying a testable
     * pattern (an optional `reason` string is shown in confirmations).
     */
    _isValidActionList(list) {
        return Array.isArray(list) && list.every(a =>
            a && typeof a === 'object' &&
            a.pattern && typeof a.pattern.test === 'function'
        );
    }

    /**
     * Register a skill
     */
    register(skill) {
        const { valid, errors } = this.validateSkill(skill);
        if (!valid) {
            state.logActivity(`Skill rejected (${skill?.name || 'unnamed'}): ${errors.join(', ')}`, 'danger');
            return false;
        }
        this._skills.set(skill.name, skill);
        // New skills default to enabled unless already tracked
        if (!this._enabled.has(skill.name)) {
            this._enabled.set(skill.name, true);
        }
        return true;
    }

    /**
     * Enable/disable a skill by name (Part 5). Disabled skills are skipped
     * by matchSkill, executeByName, and process().
     */
    setEnabled(name, enabled) {
        if (!this._skills.has(name)) return false;
        this._enabled.set(name, !!enabled);
        state.logActivity(`Skill "${name}" ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'info' : 'warning');
        return true;
    }

    isEnabled(name) {
        return this._enabled.get(name) !== false;
    }

    getEnabledMap() {
        const map = {};
        for (const name of this._skills.keys()) {
            map[name] = this.isEnabled(name);
        }
        return map;
    }

    /**
     * Get all registered skills (including disabled — used by settings UI)
     */
    getSkills() {
        return Array.from(this._skills.values());
    }

    /**
     * Get only enabled skills (used for routing and agent discovery)
     */
    getEnabledSkills() {
        return this.getSkills().filter(s => this.isEnabled(s.name));
    }

    /**
     * Unregister a skill
     */
    unregister(name) {
        this._skills.delete(name);
        this._enabled.delete(name);
    }

    /**
     * Get a specific skill
     */
    getSkill(name) {
        return this._skills.get(name);
    }

    /**
     * Process user input and route to appropriate skill
     */
    async process(input, context = {}) {
        const text = input.toLowerCase().trim();

        state.logActivity(`Processing: "${input}"`, 'info');
        state.set('aliceState', 'UNDERSTANDING');

        // Find matching skill
        const skill = this._findSkill(text);

        if (!skill) {
            return {
                success: false,
                error: 'I\'m not sure how to help with that. Could you try rephrasing?',
                input: input
            };
        }

        // Route through executeByName so the permission gateway is always
        // applied — direct execution here would bypass the boundary.
        return this.executeByName(skill.name, input, context);
    }

    /**
     * Public: find the best matching skill for a piece of text without
     * executing anything, or decide that deterministic routing must not
     * claim the request (Part 10.1). Used by the task planner to map
     * sub-tasks to tools and by the conversation loop for the single-skill
     * path.
     *
     * The historical fields are preserved:
     *   skill — the routed skill, or null when the router declines
     *   score — the strongest evidence score seen (1.0 for a pattern match)
     *
     * The decision metadata is additive:
     *   decision   — 'strong' | 'weak' | 'ambiguous' | 'none'
     *   routed     — true only for 'strong'
     *   reason     — human-readable explanation of the decision
     *   matchedBy  — 'pattern' | 'keyword' | null
     *   specificity — number of content tokens the winning pattern consumed
     *   candidates — every skill with evidence: { name, tier, score,
     *                specificity, span }, deterministically ordered
     *   contenders — names of the equally-ranked skills when 'ambiguous'
     */
    matchSkill(text) {
        return this._route(text);
    }

    /**
     * Public: execute a specific skill by name (the planner has already
     * decided which tool to use, so no pattern matching is needed here).
     * Wraps execution with the same result normalization as process().
     *
     * This is the ONE authoritative permission boundary for skill
     * execution: immediately before the skill runs, the permission
     * gateway decides ALLOW / DENY / CONFIRM. Every caller — agent,
     * conversation loop, or direct API use — passes through the same
     * check, so no path can bypass it.
     */
    async executeByName(name, input, context = {}) {
        const skill = this._skills.get(name);
        if (!skill) {
            return {
                success: false,
                error: `Skill "${name}" is not available`,
                cancelled: true,
                permission: { decision: 'unavailable', skill: name, reason: 'unknown skill' }
            };
        }
        if (!this.isEnabled(name)) {
            return {
                success: false,
                error: `Skill "${name}" is currently disabled. You can re-enable it in Settings.`,
                cancelled: true,
                permission: { decision: 'unavailable', skill: name, reason: 'skill disabled' }
            };
        }

        // ---- Permission gateway (centralized enforcement) ----
        const verdict = await permissions.gate(skill, input, context);
        if (!verdict.allowed) {
            state.logActivity(
                `Permission ${verdict.decision}: ${skill.name} — ${verdict.reason}`,
                'warning'
            );
            return {
                success: false,
                cancelled: true,
                error: verdict.message,
                skill: skill.name,
                permission: {
                    decision: verdict.decision,
                    skill: skill.name,
                    reason: verdict.reason
                }
            };
        }

        state.logActivity(`Executing skill: ${skill.name}`, 'info');
        state.setSkillState(skill.name, { pending: true });

        try {
            const result = await this._executeSkill(skill, input, context);
            this._lastSkill = skill.name;
            this._executionHistory.push({
                skill: skill.name,
                input: input,
                result: result,
                timestamp: Date.now()
            });
            return result;
        } catch (e) {
            state.logActivity(`Skill "${skill.name}" error: ${e.message}`, 'danger');
            return {
                success: false,
                error: e.message || 'Skill execution failed',
                skill: skill.name
            };
        }
    }

    /**
     * Find the best matching skill for input (internal). Returns the routed
     * skill or null — the confidence gate decides whether routing may claim
     * the request (Part 10.1).
     */
    _findSkill(text) {
        return this._route(text).skill;
    }

    // =======================================================================
    // Part 10.1 — deterministic routing confidence gate
    //
    // Decides WHETHER deterministic routing may claim a request. It never
    // executes a skill, never logs, never touches skill or app state, and
    // performs no I/O — evaluation is pure, synchronous and repeatable.
    //
    // Decisions:
    //   strong    — exactly one skill has the most specific pattern match
    //               (registration order is never used as a tie-break)
    //   weak      — only keyword evidence exists; the router declines
    //   ambiguous — two or more skills are equally well supported; the
    //               router declines instead of guessing
    //   none      — no meaningful evidence for any enabled skill
    // =======================================================================

    /**
     * Evaluate routing evidence and return the routing decision.
     */
    _route(text) {
        const t = typeof text === 'string' ? text.toLowerCase().trim() : '';

        const candidates = [];
        for (const skill of this.getEnabledSkills()) {
            const candidate = this._routingCandidate(t, skill);
            if (candidate) candidates.push(candidate);
        }

        // Deterministic order: strongest evidence first, ties broken by skill
        // name — never by registration order.
        candidates.sort((a, b) =>
            (b.specificity - a.specificity) ||
            (b.score - a.score) ||
            (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        const top = candidates[0];
        if (!top) {
            return this._routingDecision(null, 0, 'none',
                'no skill evidence for this request', null, null, candidates, []);
        }

        if (top.tier === 'pattern') {
            const leaders = candidates.filter(c =>
                c.tier === 'pattern' && c.specificity === top.specificity);
            if (leaders.length === 1) {
                return this._routingDecision(top.skill, top.score, 'strong',
                    `pattern match (specificity ${top.specificity})`,
                    'pattern', top.specificity, candidates, []);
            }
            return this._routingDecision(null, top.score, 'ambiguous',
                `equally specific pattern matches: ${leaders.map(c => c.name).join(', ')}`,
                'pattern', top.specificity, candidates, leaders.map(c => c.name));
        }

        // Keyword-only evidence is weak: it is never enough to claim a request.
        if (top.score < ROUTING_KEYWORD_FLOOR) {
            return this._routingDecision(null, top.score, 'none',
                'keyword evidence below the routing floor', 'keyword', null, candidates, []);
        }
        const leaders = candidates.filter(c =>
            c.tier === 'keyword' && Math.abs(c.score - top.score) <= ROUTING_EPSILON);
        if (leaders.length === 1) {
            return this._routingDecision(null, top.score, 'weak',
                `keyword-only evidence (score ${top.score}) is not decisive`,
                'keyword', null, candidates, []);
        }
        return this._routingDecision(null, top.score, 'ambiguous',
            `ambiguous weak matches: ${leaders.map(c => c.name).join(', ')}`,
            'keyword', null, candidates, leaders.map(c => c.name));
    }

    /**
     * Evidence for one enabled skill: a declared pattern match (strong) or
     * the fallback keyword score (weak), or null when the skill has none.
     */
    _routingCandidate(text, skill) {
        const pattern = this._patternEvidence(text, skill);
        if (pattern) {
            return {
                skill,
                name: skill.name,
                tier: 'pattern',
                score: 1.0,
                specificity: pattern.specificity,
                span: pattern.span
            };
        }

        const score = this._keywordScore(text, skill);
        if (score > 0) {
            return { skill, name: skill.name, tier: 'keyword', score, specificity: 0, span: null };
        }
        return null;
    }

    /**
     * Best pattern evidence for a skill: the match with the greatest
     * specificity (ties broken by the longer span). RegExp state is left
     * untouched so repeated evaluation is side-effect free.
     */
    _patternEvidence(text, skill) {
        if (!Array.isArray(skill.patterns)) return null;

        let best = null;
        for (const pattern of skill.patterns) {
            if (!pattern || typeof pattern.exec !== 'function') continue;

            const stateful = pattern.global || pattern.sticky;
            const savedIndex = stateful ? pattern.lastIndex : 0;
            if (stateful) pattern.lastIndex = 0;

            let match;
            try {
                match = pattern.exec(text);
            } finally {
                if (stateful) pattern.lastIndex = savedIndex;
            }
            if (!match) continue;

            const span = match[0];
            const start = match.index;
            const end = start + span.length;

            // A match that lands inside a longer word ("photo" inside
            // "photosynthesis") is an accident of the regex, not a phrase
            // match: it is not strong evidence (the skill's keyword score
            // still reports it as weak evidence).
            if (!this._isPhraseMatch(text, start, end)) continue;

            const specificity = this._matchSpecificity(span);
            if (!best || specificity > best.specificity ||
                (specificity === best.specificity && span.length > best.span.length)) {
                best = { span, specificity };
            }
        }
        return best;
    }

    /**
     * True when a match starts and ends on token boundaries, i.e. it did not
     * match a fragment of a longer word.
     */
    _isPhraseMatch(text, start, end) {
        const isWordChar = (ch) => ch !== undefined && /[a-z0-9]/i.test(ch);
        const startsMidWord = isWordChar(text[start]) && isWordChar(text[start - 1]);
        const endsMidWord = isWordChar(text[end - 1]) && isWordChar(text[end]);
        return !startsMidWord && !endsMidWord;
    }

    /**
     * Specificity of a phrase match: how many complete, non-framing tokens
     * the match consumed ("10 plus 5" => 3, "what is " => 0). A phrase match
     * that consumed only framing words is weaker evidence than one that
     * consumed real content, which is what separates the calculator's
     * `/10 plus 5/` from websearch's `/what is /` on the same request.
     */
    _matchSpecificity(span) {
        let specificity = 0;
        for (const token of span.toLowerCase().split(/[^a-z0-9$]+/)) {
            if (!token) continue;
            if (ROUTING_FRAMING_WORDS.has(token)) continue;
            specificity += 1;
        }
        return specificity;
    }

    /**
     * Assemble the routing decision. `candidates` is exposed as plain data
     * (no skill objects) so the decision can be asserted and logged directly.
     */
    _routingDecision(skill, score, decision, reason, matchedBy, specificity, candidates, contenders) {
        return {
            skill: skill || null,
            score,
            decision,
            routed: decision === 'strong',
            reason,
            matchedBy,
            specificity,
            candidates: candidates.map(c => ({
                name: c.name,
                tier: c.tier,
                score: c.score,
                specificity: c.specificity,
                span: c.span
            })),
            contenders
        };
    }

    /**
     * Weak fallback evidence: the legacy keyword table (0.2 per hit, capped
     * at 0.9). Reported by the confidence gate, never enough to route.
     */
    _keywordScore(text, skill) {
        const keywords = ROUTING_KEYWORDS[skill.name] || [];
        let score = 0;
        for (const keyword of keywords) {
            if (text.includes(keyword)) {
                score += 0.2;
            }
        }
        return Math.min(score, 0.9);
    }

    /**
     * Calculate match score for a skill (unchanged public score contract):
     * a declared pattern match scores 1.0, otherwise the weak keyword score.
     */
    _calculateMatchScore(text, skill) {
        // Check patterns
        for (const pattern of skill.patterns) {
            if (pattern.test(text)) {
                return 1.0;
            }
        }

        // Check for skill-specific keywords (weak evidence — Part 10.1)
        return this._keywordScore(text, skill);
    }

    /**
     * Execute a skill. If the skill declares an `onError` handler, it is
     * consulted before returning a failure result (Part 5 manifest).
     */
    async _executeSkill(skill, input, context) {
        let result;
        try {
            result = skill.execute(input, context);
            // If result is a promise, await it
            if (result instanceof Promise) {
                result = await result;
            }
        } catch (e) {
            result = { success: false, error: e.message || 'execution error' };
        }

        if (result && result.success === false && typeof skill.onError === 'function') {
            try {
                const recovered = skill.onError(input, result);
                if (recovered) return recovered;
            } catch (e) {
                // fall through to the original failure
            }
        }
        return result;
    }

    /**
     * Get last used skill
     */
    getLastSkill() {
        return this._lastSkill;
    }

    /**
     * Get execution history
     */
    getHistory() {
        return [...this._executionHistory];
    }

    /**
     * Clear execution history
     */
    clearHistory() {
        this._executionHistory = [];
    }

    /**
     * Check if a skill is available
     */
    hasSkill(name) {
        return this._skills.has(name);
    }
}

// Singleton instance
export const skillManager = new SkillManager();

// The class is exported (in addition to the singleton) so tests can build
// managers with a different registration order and prove that routing
// decisions are independent of it (Part 10.1).
export { SkillManager };
