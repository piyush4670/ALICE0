/**
 * ALICE Skill Manager
 * Routes user requests to appropriate skills.
 * Part 5: skills are validated plugins with an optional manifest that
 * declares name, description, permissions, risk, and error handling.
 * Skills can be individually enabled/disabled by the user.
 * Part 10.1: routing is confidence-gated — only a declared pattern match can
 * claim a request; weak keyword-only evidence and equally-ranked (ambiguous)
 * matches are reported and declined instead of guessed.
 * Part 10.2: candidate discovery is separated from claim permission —
 * finding candidates with evidence is decoupled from authorizing deterministic
 * execution ownership (see findBestCandidate and matchSkill).
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
        this._discoveredCandidates = new WeakMap(); // candidateInfo -> immutable discovery record
        
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
     * Public: candidate discovery (Part 10.2).
     * Evaluates enabled skills and returns a plain-data candidate descriptor
     * (never an executable skill object). Does NOT authorize execution or
     * claim ownership (`claimed: false`, `routed: false`, `skill: null`).
     */
    findBestCandidate(text) {
        return this._findBestCandidate(text);
    }

    /**
     * Public: evaluate whether a discovered candidate satisfies the
     * deterministic claim policy (Part 10.2). Verifies discovery provenance,
     * pattern evidence, and current registered/enabled skill state.
     */
    canClaimCandidate(candidateInfo) {
        return this._canClaim(candidateInfo);
    }

    /**
     * Public: find candidate skills and apply claim policy (Part 10.2).
     * Redefined clearly as a CLAIM decision over candidate discovery.
     * Evaluates whether deterministic routing may claim ownership of the
     * request. Weak or ambiguous candidates are declined.
     *
     * The historical fields are preserved:
     *   skill — the claimed skill object, or null when the router declines
     *   score — the strongest evidence score seen (1.0 for a pattern match)
     *
     * The decision and candidate-discovery metadata are additive:
     *   decision      — 'strong' | 'weak' | 'ambiguous' | 'none'
     *   confidence    — 'strong' | 'weak' | 'ambiguous' | 'none'
     *   routed        — true only for 'strong'
     *   claimed       — true only for 'strong' (Part 10.2 explicit claim flag)
     *   candidate     — plain-data descriptor { name, tier, score, specificity,
     *                   span } for 'strong' or 'weak', or null when
     *                   'ambiguous' / 'none' (never an executable skill object)
     *   candidateName — discovered candidate's skill name, or null
     *   reason        — human-readable explanation of the decision
     *   matchedBy     — 'pattern' | 'keyword' | null
     *   matchType     — alias for `matchedBy`
     *   specificity   — number of content tokens the winning pattern consumed
     *   candidates    — every skill with evidence: { name, tier, score,
     *                   specificity, span }, deterministically ordered
     *   contenders    — names of the equally-ranked skills when 'ambiguous'
     */
    matchSkill(text) {
        const candidateInfo = this._findBestCandidate(text);
        return this._evaluateClaim(candidateInfo);
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
     * Find the best matching skill for input (internal). Returns the claimed
     * skill or null — the claim policy decides whether routing may claim
     * ownership of the request (Part 10.1 / Part 10.2).
     */
    _findSkill(text) {
        return this.matchSkill(text).skill;
    }

    // =======================================================================
    // Part 10.1 & Part 10.2 — candidate discovery & claim policy separation
    //
    // Stage 1: Candidate discovery (`_findBestCandidate` / `findBestCandidate`)
    //   Describes what enabled skills have pattern or keyword evidence for a
    //   request and classifies confidence ('strong', 'weak', 'ambiguous',
    //   'none'). It never grants execution authorization (`claimed: false`,
    //   `routed: false`, `skill: null`).
    //
    // Stage 2: Claim policy (`_canClaim` / `_evaluateClaim` / `matchSkill`)
    //   Decides whether deterministic routing may claim execution ownership
    //   of the discovered candidate. Only strong, unambiguous pattern matches
    //   may claim (`claimed: true`, `routed: true`, `skill: candidate`).
    //   Weak keyword evidence and ambiguous contenders are declined.
    //
    // Both stages are pure, synchronous, side-effect free, and independent
    // of registration order.
    // =======================================================================

    /**
     * Internal/publicly testable abstraction for candidate discovery (Part 10.2).
     * Discovers enabled skills with pattern or keyword evidence and returns
     * a plain-data candidate descriptor (no executable skill references)
     * without implying claim authorization.
     */
    _findBestCandidate(text) {
        const normalizedText = typeof text === 'string' ? text.toLowerCase().trim() : '';
        const descriptor = this._computeCandidateDiscovery(normalizedText);

        this._discoveredCandidates.set(descriptor, Object.freeze({
            text: normalizedText,
            candidateName: descriptor.candidateName,
            confidence: descriptor.confidence,
            decision: descriptor.decision,
            matchType: descriptor.matchType,
            tier: descriptor.tier,
            score: descriptor.score,
            specificity: descriptor.specificity,
            span: descriptor.candidate ? descriptor.candidate.span : null,
            contendersCount: descriptor.contenders.length
        }));

        return descriptor;
    }

    /**
     * Pure computation of plain-data candidate discovery for normalized text.
     * Never exposes live skill instances or executable functions.
     */
    _computeCandidateDiscovery(t) {
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

        const toPlainCandidate = (c) => ({
            name: c.name,
            tier: c.tier,
            score: c.score,
            specificity: c.specificity,
            span: c.span
        });
        const serializeCandidates = (list) => list.map(toPlainCandidate);

        const top = candidates[0];
        if (!top) {
            return {
                candidate: null,
                candidateName: null,
                matchType: null,
                matchedBy: null,
                evidence: null,
                tier: null,
                score: 0,
                specificity: 0,
                confidence: 'none',
                decision: 'none',
                classification: 'none',
                reason: 'no skill evidence for this request',
                contenders: [],
                candidates: [],
                claimed: false,
                routed: false,
                skill: null
            };
        }

        if (top.tier === 'pattern') {
            const leaders = candidates.filter(c =>
                c.tier === 'pattern' && c.specificity === top.specificity);
            const isAmbiguous = leaders.length > 1;
            const contenders = isAmbiguous ? leaders.map(c => c.name) : [];
            const confidence = isAmbiguous ? 'ambiguous' : 'strong';
            const discoveredCandidate = isAmbiguous ? null : toPlainCandidate(top);
            const reason = isAmbiguous
                ? `equally specific pattern matches: ${contenders.join(', ')}`
                : `pattern match (specificity ${top.specificity})`;

            return {
                candidate: discoveredCandidate,
                candidateName: discoveredCandidate ? discoveredCandidate.name : null,
                matchType: 'pattern',
                matchedBy: 'pattern',
                evidence: 'pattern',
                tier: 'pattern',
                score: top.score,
                specificity: top.specificity,
                confidence,
                decision: confidence,
                classification: confidence,
                reason,
                contenders,
                candidates: serializeCandidates(candidates),
                claimed: false,
                routed: false,
                skill: null
            };
        }

        // Keyword-only evidence is weak: it is never enough to claim a request.
        if (top.score < ROUTING_KEYWORD_FLOOR) {
            return {
                candidate: null,
                candidateName: null,
                matchType: 'keyword',
                matchedBy: 'keyword',
                evidence: 'keyword',
                tier: 'keyword',
                score: top.score,
                specificity: 0,
                confidence: 'none',
                decision: 'none',
                classification: 'none',
                reason: 'keyword evidence below the routing floor',
                contenders: [],
                candidates: serializeCandidates(candidates),
                claimed: false,
                routed: false,
                skill: null
            };
        }

        const leaders = candidates.filter(c =>
            c.tier === 'keyword' && Math.abs(c.score - top.score) <= ROUTING_EPSILON);
        const isAmbiguous = leaders.length > 1;
        const contenders = isAmbiguous ? leaders.map(c => c.name) : [];
        const confidence = isAmbiguous ? 'ambiguous' : 'weak';
        const discoveredCandidate = isAmbiguous ? null : toPlainCandidate(top);
        const reason = isAmbiguous
            ? `ambiguous weak matches: ${contenders.join(', ')}`
            : `keyword-only evidence (score ${top.score}) is not decisive`;

        return {
            candidate: discoveredCandidate,
            candidateName: discoveredCandidate ? discoveredCandidate.name : null,
            matchType: 'keyword',
            matchedBy: 'keyword',
            evidence: 'keyword',
            tier: 'keyword',
            score: top.score,
            specificity: 0,
            confidence,
            decision: confidence,
            classification: confidence,
            reason,
            contenders,
            candidates: serializeCandidates(candidates),
            claimed: false,
            routed: false,
            skill: null
        };
    }

    /**
     * Verify that `candidateInfo` is an authentic, unmutated discovery
     * descriptor produced by this SkillManager instance and contains no
     * executable skill references or caller-injected claim flags.
     */
    _verifyDiscoveryIntegrity(candidateInfo) {
        if (!candidateInfo || typeof candidateInfo !== 'object' || Array.isArray(candidateInfo)) {
            return null;
        }
        const record = this._discoveredCandidates.get(candidateInfo);
        if (!record) return null;

        // Candidate discovery descriptors are never claimed, never routed,
        // and never carry a skill reference or execute function.
        if (
            candidateInfo.claimed !== false ||
            candidateInfo.routed !== false ||
            candidateInfo.skill !== null ||
            typeof candidateInfo.execute === 'function'
        ) {
            return null;
        }

        if (
            candidateInfo.confidence !== record.confidence ||
            candidateInfo.decision !== record.decision ||
            candidateInfo.matchType !== record.matchType ||
            candidateInfo.tier !== record.tier ||
            candidateInfo.score !== record.score ||
            candidateInfo.specificity !== record.specificity ||
            candidateInfo.candidateName !== record.candidateName
        ) {
            return null;
        }

        if (!Array.isArray(candidateInfo.contenders) || candidateInfo.contenders.length !== record.contendersCount) {
            return null;
        }
        if (!Array.isArray(candidateInfo.candidates)) {
            return null;
        }
        for (const c of candidateInfo.candidates) {
            if (!c || typeof c !== 'object' || typeof c.execute === 'function' || 'skill' in c || 'patterns' in c) {
                return null;
            }
        }

        if (record.candidateName === null) {
            if (candidateInfo.candidate !== null) return null;
        } else {
            const cand = candidateInfo.candidate;
            if (!cand || typeof cand !== 'object' || Array.isArray(cand)) return null;
            if (typeof cand.execute === 'function' || 'skill' in cand || 'patterns' in cand) return null;
            if (
                cand.name !== record.candidateName ||
                cand.tier !== record.tier ||
                cand.score !== record.score ||
                cand.specificity !== record.specificity ||
                cand.span !== record.span
            ) {
                return null;
            }
        }

        return record;
    }

    /**
     * Internal claim authorization resolver (Part 10.2):
     * Verifies candidate discovery provenance and evidence, resolves the
     * candidate against currently registered and enabled skills, and
     * re-verifies that the skill still has an unambiguous pattern match.
     * Returns the registered skill object only when authorization succeeds.
     */
    _resolveAuthorizedSkill(candidateInfo) {
        const record = this._verifyDiscoveryIntegrity(candidateInfo);
        if (!record) return null;

        if (
            record.confidence !== 'strong' ||
            record.decision !== 'strong' ||
            record.matchType !== 'pattern' ||
            record.tier !== 'pattern' ||
            record.score !== 1.0 ||
            typeof record.specificity !== 'number' ||
            !Number.isFinite(record.specificity) ||
            record.specificity < 0 ||
            record.contendersCount !== 0 ||
            typeof record.candidateName !== 'string' ||
            !record.candidateName ||
            typeof record.span !== 'string' ||
            !record.span
        ) {
            return null;
        }

        // Resolve against current registered, enabled skills
        const liveSkill = this._skills.get(record.candidateName);
        if (!liveSkill || !this.isEnabled(record.candidateName)) {
            return null;
        }

        // Re-verify live pattern evidence across current enabled skills so
        // stale candidate metadata cannot authorize a skill after registry
        // or enablement changes.
        const liveDiscovery = this._computeCandidateDiscovery(record.text);
        if (
            liveDiscovery.confidence !== 'strong' ||
            liveDiscovery.decision !== 'strong' ||
            liveDiscovery.matchType !== 'pattern' ||
            liveDiscovery.candidateName !== record.candidateName ||
            liveDiscovery.specificity !== record.specificity ||
            liveDiscovery.contenders.length !== 0 ||
            !liveDiscovery.candidate ||
            liveDiscovery.candidate.span !== record.span
        ) {
            return null;
        }

        return liveSkill;
    }

    /**
     * Deterministic claim policy predicate (Part 10.2):
     * Only strong, unambiguous pattern matches verified against current
     * registered, enabled skills may claim execution ownership.
     */
    _canClaim(candidateInfo) {
        return Boolean(this._resolveAuthorizedSkill(candidateInfo));
    }

    /**
     * Claim policy evaluation: decides whether deterministic routing may
     * claim ownership of the request while preserving candidate-discovery
     * metadata and the public `matchSkill()` contract (Part 10.2).
     */
    _evaluateClaim(candidateInfo) {
        const record = this._verifyDiscoveryIntegrity(candidateInfo);
        if (!record) {
            return {
                skill: null,
                score: 0,
                decision: 'none',
                confidence: 'none',
                routed: false,
                claimed: false,
                candidate: null,
                candidateName: null,
                reason: 'unverified or invalid candidate metadata',
                matchedBy: null,
                matchType: null,
                specificity: null,
                candidates: [],
                contenders: []
            };
        }

        const live = this._computeCandidateDiscovery(record.text);
        const claimedSkill = this._resolveAuthorizedSkill(candidateInfo);
        const canClaim = Boolean(claimedSkill);

        return {
            skill: canClaim ? claimedSkill : null,
            score: live.score,
            decision: live.confidence,
            confidence: live.confidence,
            routed: canClaim,
            claimed: canClaim,
            candidate: live.candidate ? { ...live.candidate } : null,
            candidateName: live.candidateName,
            reason: live.reason,
            matchedBy: live.matchType,
            matchType: live.matchType,
            specificity: live.matchType === 'pattern' ? live.specificity : null,
            candidates: live.candidates.map(c => ({
                name: c.name,
                tier: c.tier,
                score: c.score,
                specificity: c.specificity,
                span: c.span
            })),
            contenders: [...live.contenders]
        };
    }

    /**
     * Compatibility alias for matchSkill.
     */
    _route(text) {
        return this.matchSkill(text);
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
