/**
 * ALICE Skill Manager
 * Routes user requests to appropriate skills
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

class SkillManager {
    constructor() {
        this._skills = new Map();
        this._lastSkill = null;
        this._executionHistory = [];
        
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
        
        state.logActivity(`Registered ${this._skills.size} skills`, 'info');
    }

    /**
     * Register a skill
     */
    register(skill) {
        this._skills.set(skill.name, skill);
    }

    /**
     * Unregister a skill
     */
    unregister(name) {
        return this._skills.delete(name);
    }

    /**
     * Get all registered skills
     */
    getSkills() {
        return Array.from(this._skills.values());
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
        for (const skill of this._skills.values()) {
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

        for (const skill of this._skills.values()) {
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
            memory: ['remember', 'my', 'forget', 'recall']
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
     * Execute a skill
     */
    async _executeSkill(skill, input, context) {
        const result = skill.execute(input, context);
        
        // If result is a promise, await it
        if (result instanceof Promise) {
            return await result;
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
