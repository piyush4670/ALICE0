/**
 * ALICE Mock Model Adapter (Phase 6.2)
 * ------------------------------------------------------------------
 * Provider-neutral, deterministic mock adapter for testing and offline operation.
 *
 * Guarantees:
 *   - ZERO network requests
 *   - ZERO external API keys or credentials
 *   - 100% deterministic outputs
 *   - Configurable test hooks (failures, delays, malformed outputs, custom plans)
 */
import { ModelAdapter, AIProviderError, AIValidationError, AITimeoutError } from './modelAdapter.js';
import { skillManager } from '../skillManager.js';
import { delay } from '../utils.js';

export class MockAdapter extends ModelAdapter {
    constructor(config = {}) {
        super(config);
        this._mockResponses = [];
        this._customPlans = [];
        this._shouldFail = false;
        this._failureError = null;
        this._delayMs = 0;
        this._malformedOutput = false;
        this._hangIndefinitely = false;
    }

    // ==================================================================
    // Test Hooks & Configuration
    // ==================================================================

    /**
     * Set a canned response for prompts matching a string, regex, or predicate.
     */
    setMockResponse(patternOrFn, response) {
        this._mockResponses.push({ match: patternOrFn, response });
    }

    /**
     * Set a custom plan for goals matching a pattern.
     */
    setCustomPlan(patternOrFn, plan) {
        this._customPlans.push({ match: patternOrFn, plan });
    }

    /**
     * Simulate adapter failure.
     */
    setFailure(shouldFail = true, error = null) {
        this._shouldFail = !!shouldFail;
        this._failureError = error;
    }

    /**
     * Simulate processing delay (latency).
     */
    setDelay(ms = 0) {
        this._delayMs = Math.max(0, Number(ms) || 0);
    }

    /**
     * Simulate hanging/infinite wait to test timeouts.
     */
    setHang(hang = true) {
        this._hangIndefinitely = !!hang;
    }

    /**
     * Simulate malformed non-JSON output.
     */
    setMalformedOutput(malformed = true) {
        this._malformedOutput = !!malformed;
    }

    /**
     * Reset all test hooks.
     */
    reset() {
        this._mockResponses = [];
        this._customPlans = [];
        this._shouldFail = false;
        this._failureError = null;
        this._delayMs = 0;
        this._malformedOutput = false;
        this._hangIndefinitely = false;
    }

    // ==================================================================
    // Core Generation Implementation
    // ==================================================================

    async generate(prompt, options = {}) {
        const timeoutMs = options.timeout || this._config.timeout || 5000;
        const signal = options.signal || null;

        return this.withTimeout(this._executeGenerate(prompt, options), timeoutMs, signal);
    }

    async _executeGenerate(prompt, options = {}) {
        const textPrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);

        // 1. Check if configured to hang indefinitely (timeout testing)
        if (this._hangIndefinitely) {
            await new Promise(() => {}); // never resolves
        }

        // 2. Simulated latency
        if (this._delayMs > 0) {
            await delay(this._delayMs);
        }

        // 3. Simulated failure
        if (this._shouldFail) {
            const err = this._failureError || new Error('Simulated mock model adapter failure');
            throw this.normalizeError(err);
        }

        // 4. Simulated malformed output
        if (this._malformedOutput) {
            return {
                text: '<<< MALFORMED OUTPUT NOT VALID JSON >>> { goal: missing quotes',
                structured: null
            };
        }

        // 5. Check custom mock responses
        for (const item of this._mockResponses) {
            if (this._matches(item.match, textPrompt)) {
                const res = typeof item.response === 'function' ? item.response(prompt, options) : item.response;
                if (typeof res === 'object') {
                    return { text: JSON.stringify(res), structured: res };
                }
                return { text: String(res), structured: null };
            }
        }

        // 6. Check custom plans
        for (const item of this._customPlans) {
            if (this._matches(item.match, textPrompt)) {
                const plan = typeof item.plan === 'function' ? item.plan(prompt, options) : item.plan;
                return {
                    text: JSON.stringify(plan),
                    structured: plan
                };
            }
        }

        // 7. Deterministic heuristic planning / generation
        return this._deterministicGenerate(textPrompt, options);
    }

    _matches(matcher, text) {
        if (typeof matcher === 'string') return text.toLowerCase().includes(matcher.toLowerCase());
        if (matcher instanceof RegExp) return matcher.test(text);
        if (typeof matcher === 'function') return !!matcher(text);
        return false;
    }

    /**
     * Deterministic generation based on input heuristics.
     */
    _deterministicGenerate(promptText, options = {}) {
        const format = options.responseFormat || 'json';

        // Extract clean goal text from prompt
        const goalMatch = promptText.match(/User Request:\s*"([^"]+)"/i) ||
                          promptText.match(/Goal:\s*"([^"]+)"/i);
        const goal = goalMatch ? goalMatch[1].trim() : promptText.trim();

        if (format === 'text') {
            return {
                text: `I have processed your request for "${goal}". Everything is up to date.`,
                structured: null
            };
        }

        // Check if multi-step goal
        const plan = this._buildDeterministicPlan(goal);
        if (plan) {
            return {
                text: JSON.stringify(plan, null, 2),
                structured: plan
            };
        }

        // Single-intent response
        const directResp = {
            goal,
            type: 'response',
            response: `I understood your request: "${goal}".`
        };

        return {
            text: JSON.stringify(directResp, null, 2),
            structured: directResp
        };
    }

    // ------------------------------------------------------------------
    // Deterministic Multi-Step Plan Builder
    // ------------------------------------------------------------------

    _buildDeterministicPlan(text) {
        const t = text.toLowerCase();

        // 1. Check for Research + Summarize + Document
        if (this._has(t, 'research') && this._has(t, 'summarize') && this._has(t, 'document')) {
            const topic = this._extractTopic(text);
            return {
                goal: text,
                steps: [
                    {
                        id: 'step_1',
                        label: `Research ${topic || 'topic'}`,
                        skill: 'websearch',
                        action: 'search',
                        input: topic || 'general information',
                        contextKey: 'research',
                        dependsOn: [],
                        risk: 'safe'
                    },
                    {
                        id: 'step_2',
                        label: 'Summarize research findings',
                        skill: 'core',
                        operation: 'summarize',
                        input: '',
                        inputSource: 'research',
                        contextKey: 'summary',
                        dependsOn: ['step_1'],
                        risk: 'safe'
                    },
                    {
                        id: 'step_3',
                        label: 'Create research document',
                        skill: 'files',
                        action: 'create',
                        input: '',
                        inputSource: 'summary',
                        contextKey: 'document',
                        filename: 'alice-research.txt',
                        dependsOn: ['step_2'],
                        risk: 'safe'
                    }
                ]
            };
        }

        // 2. Check for Research + Summarize + Note
        if (this._has(t, 'research') && this._has(t, 'summarize') && this._has(t, 'note')) {
            const topic = this._extractTopic(text);
            return {
                goal: text,
                steps: [
                    {
                        id: 'step_1',
                        label: `Research ${topic || 'topic'}`,
                        skill: 'websearch',
                        action: 'search',
                        input: topic || 'general information',
                        contextKey: 'research',
                        dependsOn: [],
                        risk: 'safe'
                    },
                    {
                        id: 'step_2',
                        label: 'Summarize research findings',
                        skill: 'core',
                        operation: 'summarize',
                        input: '',
                        inputSource: 'research',
                        contextKey: 'summary',
                        dependsOn: ['step_1'],
                        risk: 'safe'
                    },
                    {
                        id: 'step_3',
                        label: 'Save summary to notes',
                        skill: 'notes',
                        action: 'create',
                        input: '',
                        inputSource: 'summary',
                        contextKey: 'note',
                        dependsOn: ['step_2'],
                        risk: 'safe'
                    }
                ]
            };
        }

        // 3. Check for Research + Summarize
        if (this._has(t, 'research') && this._has(t, 'summarize')) {
            const topic = this._extractTopic(text);
            return {
                goal: text,
                steps: [
                    {
                        id: 'step_1',
                        label: `Research ${topic || 'topic'}`,
                        skill: 'websearch',
                        action: 'search',
                        input: topic || 'general information',
                        contextKey: 'research',
                        dependsOn: [],
                        risk: 'safe'
                    },
                    {
                        id: 'step_2',
                        label: 'Summarize research findings',
                        skill: 'core',
                        operation: 'summarize',
                        input: '',
                        inputSource: 'research',
                        contextKey: 'summary',
                        dependsOn: ['step_1'],
                        risk: 'safe'
                    }
                ]
            };
        }

        // 4. Check for Research + Note
        if (this._has(t, 'research') && this._has(t, 'note')) {
            const topic = this._extractTopic(text);
            return {
                goal: text,
                steps: [
                    {
                        id: 'step_1',
                        label: `Research ${topic || 'topic'}`,
                        skill: 'websearch',
                        action: 'search',
                        input: topic || 'general information',
                        contextKey: 'research',
                        dependsOn: [],
                        risk: 'safe'
                    },
                    {
                        id: 'step_2',
                        label: 'Save research to notes',
                        skill: 'notes',
                        action: 'create',
                        input: '',
                        inputSource: 'research',
                        contextKey: 'note',
                        dependsOn: ['step_1'],
                        risk: 'safe'
                    }
                ]
            };
        }

        // 5. Check for Research + Document
        if (this._has(t, 'research') && this._has(t, 'document')) {
            const topic = this._extractTopic(text);
            return {
                goal: text,
                steps: [
                    {
                        id: 'step_1',
                        label: `Research ${topic || 'topic'}`,
                        skill: 'websearch',
                        action: 'search',
                        input: topic || 'general information',
                        contextKey: 'research',
                        dependsOn: [],
                        risk: 'safe'
                    },
                    {
                        id: 'step_2',
                        label: 'Save research document',
                        skill: 'files',
                        action: 'create',
                        input: '',
                        inputSource: 'research',
                        contextKey: 'document',
                        filename: 'alice-research.txt',
                        dependsOn: ['step_1'],
                        risk: 'safe'
                    }
                ]
            };
        }

        // 6. Generic connector splitter for multi-step goals
        const connectorRegex = /\b(?:and\s+then|then|after\s+that|afterwards|and\s+finally|and\s+also|finally|,\s*(?:then\s+)?)/i;
        const parts = text.split(connectorRegex).map(s => s.trim()).filter(Boolean);
        if (parts.length > 1) {
            const steps = [];
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const match = skillManager.matchSkill(part);
                if (!match || !match.skill) continue;

                const stepId = `step_${i + 1}`;
                const prevId = i > 0 ? `step_${i}` : null;
                const risk = /\b(delete|remove|erase|clear|forget|wipe)\b/i.test(part) ? 'sensitive' : 'safe';

                steps.push({
                    id: stepId,
                    label: part,
                    skill: match.skill.name,
                    action: part,
                    input: part,
                    contextKey: stepId,
                    dependsOn: prevId ? [prevId] : [],
                    risk
                });
            }

            if (steps.length > 1) {
                return {
                    goal: text,
                    steps
                };
            }
        }

        return null;
    }

    _has(text, intent) {
        const patterns = {
            research: /\b(research|search(?:\s+the\s+web)?|look\s+up|lookup|find\s+(?:out\s+)?(?:about|information\s+(?:on|about)|info\s+(?:on|about))|google)\b/i,
            summarize: /\b(summar[iy]ze|summar[y]|sum\s+up|condense|brief|process\s+(?:the\s+)?information)\b/i,
            document: /\b(create|make|write|produce|generate|build)\b.*\b(document|file|report|paper|write[- ]?up|text\s+file|\.txt|\.md|\.html)\b/i,
            note: /\b(take|save|make|add)\b.*\b(note)\b|\b(write\s+down|save\s+this|remember\s+this)\b/i
        };
        return patterns[intent] ? patterns[intent].test(text) : false;
    }

    _extractTopic(text) {
        return text
            .replace(/^(?:please\s+)?(?:research|search(?:\s+the\s+web)?(?:\s+for)?|look\s+up|lookup|find\s+(?:out\s+)?(?:about|information\s+(?:on|about)|info\s+(?:on|about))|google)\s+/i, '')
            .replace(/(?:,\s*)?(?:and\s+)?(?:then\s+)?(?:summar[iy]ze|summar[y]|sum\s+up|create|make|write|produce|generate|build|save|take|add).*$/i, '')
            .replace(/[?.!]+$/, '')
            .trim();
    }
}
