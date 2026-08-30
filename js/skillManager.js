/**
 * ALICE Skill Manager
 * Routes user requests to appropriate skills.
 * Part 5: skills are validated plugins with an optional manifest that
 * declares name, description, permissions, risk, and error handling.
 * Skills can be individually enabled/disabled by the user.
 */
import { state } from './state.js';
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
        return { valid: errors.length === 0, errors };
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

        state.logActivity(`Selected skill: ${skill.name}`, 'info');
        state.set('aliceState', 'SELECTING_TOOL');

        // Execute the skill
        state.set('aliceState', 'EXECUTING');
        
        try {
            const result = await this._executeSkill(skill, input, context);
            
            this._lastSkill = skill.name;
            this._executionHistory.push({
                skill: skill.name,
                input: input,
                result: result,
                timestamp: Date.now()
            });

            state.set('aliceState', 'COMPLETING');
            
            return result;
            
        } catch (e) {
            state.logActivity(`Skill execution error: ${e.message}`, 'danger');
            state.set('aliceState', 'IDLE');
            
            return {
                success: false,
                error: `I encountered an error: ${e.message}`
            };
        }
    }

    /**
     * Public: find the best matching skill for a piece of text without
     * executing anything. Used by the task planner to map sub-tasks to tools.
     * Returns { skill, score } or { skill: null, score: 0 }.
     */
    matchSkill(text) {
        const t = text.toLowerCase().trim();
        let bestMatch = null;
        let bestScore = 0;
        for (const skill of this.getEnabledSkills()) {
            const score = this._calculateMatchScore(t, skill);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = skill;
            }
        }
        return {
            skill: bestScore >= 0.3 ? bestMatch : null,
            score: bestScore
        };
    }

    /**
     * Public: execute a specific skill by name (the planner has already
     * decided which tool to use, so no pattern matching is needed here).
     * Wraps execution with the same result normalization as process().
     */
    async executeByName(name, input, context = {}) {
        const skill = this._skills.get(name);
        if (!skill) {
            return {
                success: false,
                error: `Skill "${name}" is not available`
            };
        }
        if (!this.isEnabled(name)) {
            return {
                success: false,
                error: `Skill "${name}" is currently disabled. You can re-enable it in Settings.`
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
     * Find the best matching skill for input
     */
    _findSkill(text) {
        let bestMatch = null;
        let bestScore = 0;

        for (const skill of this.getEnabledSkills()) {
            const score = this._calculateMatchScore(text, skill);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = skill;
            }
        }

        // Only return if score is above threshold
        return bestScore >= 0.3 ? bestMatch : null;
    }

    /**
     * Calculate match score for a skill
     */
    _calculateMatchScore(text, skill) {
        // Check patterns
        for (const pattern of skill.patterns) {
            if (pattern.test(text)) {
                return 1.0;
            }
        }

        // Check for skill-specific keywords
        const keywords = {
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

        const skillKeywords = keywords[skill.name] || [];
        let score = 0;
        
        for (const keyword of skillKeywords) {
            if (text.includes(keyword)) {
                score += 0.2;
            }
        }

        return Math.min(score, 0.9);
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
