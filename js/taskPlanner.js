/**
 * ALICE Task Planner (Part 4)
 * ------------------------------------------------------------------
 * Understands a user's goal and breaks it into an ordered, high-level
 * plan of steps, each bound to an available skill/tool.
 *
 * This is a deterministic, rule-based planner: it recognizes goals and
 * composes them from the skills already registered in Part 3. It does NOT
 * do any hidden "reasoning" — it only produces the high-level task list
 * that is shown in the HUD. Internal chain-of-thought is never exposed.
 */
import { skillManager } from './skillManager.js';

// Connectors that separate multiple sub-tasks in a single utterance
const CONNECTOR = /\b(?:and\s+then|then|after\s+that|afterwards|and\s+finally|and\s+also|finally|,\s*(?:then\s+)?)/i;

// Intent detectors (order-independent; used to decide which recipe applies)
const INTENT = {
    research: /\b(research|search(?:\s+the\s+web)?|look\s+up|lookup|find\s+(?:out\s+)?(?:about|information\s+(?:on|about)|info\s+(?:on|about))|google|what\s+is|who\s+is)\b/i,
    summarize: /\b(summar[iy]ze|summar[y]|sum\s+up|condense|brief|boil\s+down|process\s+(?:the\s+)?information)\b/i,
    document: /\b(create|make|write|produce|generate|build)\b.*\b(document|file|report|paper|write[- ]?up|text\s+file|\.txt|\.md|\.html)\b/i,
    note: /\b(take|save|make|add)\b.*\b(note)\b|\b(write\s+down|save\s+this|remember\s+this)\b/i,
    delete: /\b(delete|remove|erase|clear|forget|wipe)\b/i
};

class TaskPlanner {
    /**
     * Analyze a goal. Returns:
     *   { isMultiStep, goal, plan }
     * `plan` is an array of steps: { id, label, skill, operation, action,
     *   input, inputSource, contextKey, risk, retries, alternatives, filename }
     */
    analyze(goal) {
        const text = String(goal || '').trim();
        if (!text) return { isMultiStep: false, goal, plan: [] };

        // Try curated multi-step recipes first (they produce the cleanest plans)
        const recipes = [
            this._researchSummarizeDocument,
            this._researchSummarizeNote,
            this._researchSummarize,
            this._researchNote,
            this._researchDocument
        ];

        for (const recipe of recipes) {
            const plan = recipe.call(this, text);
            if (plan) return { isMultiStep: true, goal, plan };
        }

        // Generic fallback: split on connectors and map each clause to a skill.
        const plan = this._splitAndMap(text);
        if (plan && plan.length > 1) {
            return { isMultiStep: true, goal, plan };
        }

        return { isMultiStep: false, goal, plan: [] };
    }

    // ----- Recipe helpers -------------------------------------------------

    _extractTopic(text) {
        return text
            .replace(/^(?:please\s+)?(?:research|search(?:\s+the\s+web)?(?:\s+for)?|look\s+up|lookup|find\s+(?:out\s+)?(?:about|information\s+(?:on|about)|info\s+(?:on|about))|google)\s+/i, '')
            .replace(/(?:,\s*)?(?:and\s+)?(?:then\s+)?(?:summar[iy]ze|summar[y]|sum\s+up|create|make|write|produce|generate|build|save|take|add).*$/i, '')
            .replace(/[?.!]+$/, '')
            .trim();
    }

    _has(text, intent) {
        return INTENT[intent].test(text);
    }

    _researchStep(text) {
        const topic = this._extractTopic(text);
        return {
            id: 'research',
            label: `Research ${topic || 'topic'}`,
            skill: 'websearch',
            operation: null,
            action: 'search',
            input: topic,
            inputSource: null,
            contextKey: 'research',
            risk: 'safe',
            retries: 1,
            alternatives: [],
            filename: null
        };
    }

    _summarizeStep() {
        return {
            id: 'summarize',
            label: 'Process information',
            skill: 'core',
            operation: 'summarize',
            action: 'summarize',
            input: '',
            inputSource: 'research',
            contextKey: 'summary',
            risk: 'safe',
            retries: 0,
            alternatives: [],
            filename: null
        };
    }

    _documentStep(sourceKey) {
        return {
            id: 'document',
            label: 'Create document',
            skill: 'files',
            operation: null,
            action: 'create',
            input: '',
            inputSource: sourceKey,
            contextKey: 'document',
            risk: 'safe',
            retries: 1,
            alternatives: ['notes'], // fall back to saving a note if download fails
            filename: 'alice-research.txt'
        };
    }

    _noteStep(sourceKey) {
        return {
            id: 'note',
            label: 'Save to notes',
            skill: 'notes',
            operation: null,
            action: 'create',
            input: '',
            inputSource: sourceKey,
            contextKey: 'note',
            risk: 'safe',
            retries: 0,
            alternatives: [],
            filename: null
        };
    }

    // ----- Curated multi-step recipes -------------------------------------

    _researchSummarizeDocument(text) {
        if (!this._has(text, 'research')) return null;
        if (!this._has(text, 'summarize')) return null;
        if (!this._has(text, 'document')) return null;
        return [
            this._researchStep(text),
            this._summarizeStep(),
            this._documentStep('summary')
        ];
    }

    _researchSummarizeNote(text) {
        if (!this._has(text, 'research')) return null;
        if (!this._has(text, 'summarize')) return null;
        if (!this._has(text, 'note')) return null;
        return [
            this._researchStep(text),
            this._summarizeStep(),
            this._noteStep('summary')
        ];
    }

    _researchSummarize(text) {
        if (!this._has(text, 'research')) return null;
        if (!this._has(text, 'summarize')) return null;
        return [
            this._researchStep(text),
            this._summarizeStep()
        ];
    }

    _researchNote(text) {
        if (!this._has(text, 'research')) return null;
        if (!this._has(text, 'note')) return null;
        return [
            this._researchStep(text),
            this._noteStep('research')
        ];
    }

    _researchDocument(text) {
        if (!this._has(text, 'research')) return null;
        if (!this._has(text, 'document')) return null;
        return [
            this._researchStep(text),
            this._documentStep('research')
        ];
    }

    // ----- Generic connector splitter -------------------------------------

    _splitAndMap(text) {
        const parts = text.split(CONNECTOR).map(s => s.trim()).filter(Boolean);
        if (parts.length <= 1) return null;

        const steps = [];
        for (const part of parts) {
            const match = skillManager.matchSkill(part);
            if (!match || !match.skill) continue;

            const risk = this._has(part, 'delete') ? 'sensitive' : 'safe';
            steps.push({
                id: `step_${steps.length + 1}`,
                label: part,
                skill: match.skill.name,
                operation: null,
                action: part,
                input: part,
                inputSource: null,
                contextKey: `step_${steps.length + 1}`,
                risk,
                retries: 1,
                alternatives: [],
                filename: null
            });
        }
        return steps.length > 1 ? steps : null;
    }
}

// Singleton instance
export const taskPlanner = new TaskPlanner();
