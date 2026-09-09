/**
 * ALICE AI Brain (Phase 6.2)
 * ------------------------------------------------------------------
 * Model-agnostic AI Brain layer that understands natural-language requests,
 * proposes structured plans, and synthesizes natural-language responses.
 *
 * Architecture:
 *
 *     User
 *      ↓
 *     Conversation
 *      ↓
 *     AI Brain
 *      ↓
 *     ModelAdapter  (MockAdapter | HttpModelAdapter → local gateway)
 *      ↓
 *     Intent / Structured Plan
 *      ↓
 *     Plan Validator
 *      ↓
 *     Existing Agent
 *      ↓
 *     Permission Gateway
 *      ↓
 *     SkillManager
 *      ↓
 *     Skill
 *      ↓
 *     Result
 *      ↓
 *     AI Brain
 *      ↓
 *     Natural-language response
 *
 * Security guarantees:
 *   - AI Brain NEVER directly executes arbitrary JavaScript
 *   - AI Brain NEVER directly accesses sensitive tools
 *   - AI Brain only PROPOSES actions; existing safety gates validate and execute
 *   - Model output is strictly untrusted data
 */
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { ModelAdapter, AIValidationError } from './modelAdapter.js';
import { MockAdapter } from './mockAdapter.js';
import { HttpModelAdapter } from './httpModelAdapter.js';
import { planValidator as defaultPlanValidator } from './planValidator.js';
import { toolDiscovery as defaultToolDiscovery } from './toolDiscovery.js';
import { memoryAdapter as defaultMemoryAdapter } from './memoryAdapter.js';
import { contextBuilder as defaultContextBuilder } from './contextBuilder.js';

/**
 * Adapter registry (Phase 6.3.2).
 *
 * Both adapters implement the same ModelAdapter abstraction:
 *   - 'mock' : deterministic, zero-network offline adapter (DEFAULT)
 *   - 'http' : HttpModelAdapter, talks only to the local ALICE gateway
 *
 * The registry only maps identifiers to constructors — it holds no
 * credentials and performs no network I/O.
 */
const ADAPTER_FACTORIES = {
    mock: (config = {}) => new MockAdapter(config),
    http: (config = {}) => new HttpModelAdapter(config)
};

/**
 * Create a model adapter by identifier.
 * 'mock' remains the default: the HTTP adapter is available but is NOT
 * wired as the default provider until a later phase flips CONFIG.ai.adapter.
 *
 * @param {string} [type] - 'mock' | 'http'
 * @param {Object} [config] - Adapter-specific configuration
 * @returns {ModelAdapter}
 */
export function createModelAdapter(type = CONFIG.ai?.adapter || 'mock', config = {}) {
    const key = String(type || 'mock').toLowerCase();
    const factory = ADAPTER_FACTORIES[key];
    if (!factory) {
        throw new Error(`Unknown model adapter "${type}". Available adapters: ${Object.keys(ADAPTER_FACTORIES).join(', ')}`);
    }
    return factory(config);
}

export class AIBrain {
    constructor({
        adapter = null,
        validator = defaultPlanValidator,
        toolDiscovery = defaultToolDiscovery,
        memoryAdapter = defaultMemoryAdapter,
        contextBuilder = defaultContextBuilder
    } = {}) {
        // Defaults to the configured adapter (CONFIG.ai.adapter, currently
        // 'mock'), so behaviour is unchanged while 'http' stays available.
        this._adapter = adapter || createModelAdapter();
        this._validator = validator;
        this._toolDiscovery = toolDiscovery;
        this._memoryAdapter = memoryAdapter;
        this._contextBuilder = contextBuilder;
        this._enabled = true;
    }

    // ==================================================================
    // Public State & Configuration API
    // ==================================================================

    /**
     * Check if AI Brain is active and enabled.
     */
    isEnabled() {
        const globalEnabled = CONFIG.ai?.enabled !== false;
        return this._enabled && globalEnabled;
    }

    /**
     * Toggle AI Brain enabled state.
     */
    setEnabled(enabled) {
        this._enabled = !!enabled;
        state.logActivity(`AI Brain ${this._enabled ? 'enabled' : 'disabled'}`, 'info');
    }

    /**
     * Get the active model adapter.
     */
    getAdapter() {
        return this._adapter;
    }

    /**
     * Set a new model adapter (MockAdapter or HttpModelAdapter).
     */
    setAdapter(adapter) {
        if (!(adapter instanceof ModelAdapter)) {
            throw new Error('Adapter must inherit from ModelAdapter');
        }
        this._adapter = adapter;
    }

    /**
     * Create an adapter by identifier without installing it.
     * @param {string} [type] - 'mock' | 'http'
     * @param {Object} [config]
     */
    createAdapter(type, config = {}) {
        return createModelAdapter(type, config);
    }

    /**
     * Identifiers supported by the adapter registry.
     */
    getAvailableAdapters() {
        return Object.keys(ADAPTER_FACTORIES);
    }

    /**
     * Human-readable name of the installed adapter.
     */
    getAdapterName() {
        return this._adapter?.constructor?.name || 'unknown';
    }

    getValidator() {
        return this._validator;
    }

    getToolDiscovery() {
        return this._toolDiscovery;
    }

    getContextBuilder() {
        return this._contextBuilder;
    }

    getMemoryAdapter() {
        return this._memoryAdapter;
    }

    /**
     * Reset conversation context / memory state.
     */
    resetConversation() {
        state.logActivity('AI Brain conversation context reset', 'info');
    }

    // ==================================================================
    // Core AI Brain API
    // ==================================================================

    /**
     * Process an incoming natural language request.
     * Builds context, generates plan or response, validates plan, and returns
     * structured outcome.
     *
     * @param {string} request - User natural language text
     * @param {Object} [options]
     * @returns {Promise<Object>} Processed result or fallback indicator
     */
    async processRequest(request, options = {}) {
        const text = String(request || '').trim();

        if (!text) {
            return {
                success: false,
                isMultiStep: false,
                response: 'Please provide a request or instruction.',
                error: 'Empty request'
            };
        }

        if (!this.isEnabled()) {
            return {
                success: false,
                disabled: true,
                fallback: true,
                error: 'AI Brain is currently disabled'
            };
        }

        try {
            // 1. Build bounded context
            const context = this._contextBuilder.buildContext({
                request: text,
                ...options
            });

            // 2. Generate structured plan or response via adapter
            const generation = await this.generatePlan(text, context, options);

            // 3. Handle generated multi-step plan
            if (generation.isPlan && generation.plan) {
                // Validate plan strictly with PlanValidator
                const validation = this._validator.validate(generation.plan);

                if (!validation.valid) {
                    state.logActivity(`AI plan rejected by Plan Validator: ${validation.errors.join('; ')}`, 'warning');
                    return {
                        success: false,
                        fallback: true,
                        error: `Invalid AI plan: ${validation.errors.join('; ')}`,
                        validationErrors: validation.errors
                    };
                }

                return {
                    success: true,
                    isMultiStep: true,
                    goal: text,
                    plan: validation.normalizedPlan,
                    raw: generation.raw
                };
            }

            // 4. Handle direct natural language response
            if (generation.isDirectResponse) {
                return {
                    success: true,
                    isMultiStep: false,
                    response: generation.response,
                    raw: generation.raw
                };
            }

            // Fallback if neither
            return {
                success: false,
                fallback: true,
                error: 'AI did not produce a recognizable plan or response'
            };
        } catch (err) {
            const normErr = this._adapter.normalizeError(err);
            state.logActivity(`AI Brain generation error: ${normErr.message}`, 'warning');

            return {
                success: false,
                fallback: true,
                error: normErr.message,
                code: normErr.code
            };
        }
    }

    /**
     * Generate a structured plan for a goal.
     * @param {string} goal
     * @param {Object} [context]
     * @param {Object} [options]
     * @returns {Promise<{ isPlan: boolean, plan?: Object, isDirectResponse?: boolean, response?: string, raw: any }>}
     */
    async generatePlan(goal, context = null, options = {}) {
        const fullContext = context || this._contextBuilder.buildContext({ request: goal });
        const prompt = this._contextBuilder.formatForPrompt(fullContext);

        const result = await this._adapter.generate(prompt, {
            responseFormat: 'plan',
            timeout: options.timeout || CONFIG.ai?.timeout || 5000,
            signal: options.signal || null,
            ...options
        });

        if (!result) {
            throw new Error('Model adapter returned empty result');
        }

        // If structured output is already present
        if (result.structured) {
            if (result.structured.steps && Array.isArray(result.structured.steps)) {
                return {
                    isPlan: true,
                    plan: result.structured,
                    raw: result
                };
            }
            if (result.structured.response) {
                return {
                    isDirectResponse: true,
                    response: result.structured.response,
                    raw: result
                };
            }
        }

        // Attempt to parse structured output from raw text
        if (result.text) {
            const parsed = this._adapter.parseStructuredOutput(result.text);
            if (parsed.steps && Array.isArray(parsed.steps)) {
                return {
                    isPlan: true,
                    plan: parsed,
                    raw: result
                };
            }
            if (parsed.response) {
                return {
                    isDirectResponse: true,
                    response: parsed.response,
                    raw: result
                };
            }
            throw new AIValidationError('Parsed JSON output did not contain valid plan steps or response');
        }

        return {
            isDirectResponse: true,
            response: result.text || 'Understood.',
            raw: result
        };
    }

    /**
     * Synthesize a natural-language response given user request, execution results, and context.
     * @param {string} request
     * @param {Object} executionResult
     * @param {Object} [context]
     * @param {Object} [options]
     * @returns {Promise<string>}
     */
    async generateResponse(request, executionResult, context = null, options = {}) {
        const prompt = `User Request: "${request}"\nExecution Result: ${JSON.stringify(executionResult)}\nSynthesize a clear, friendly, and concise response.`;

        try {
            const result = await this._adapter.generate(prompt, {
                responseFormat: 'text',
                timeout: options.timeout || CONFIG.ai?.timeout || 5000,
                signal: options.signal || null,
                ...options
            });

            return result.text || 'Task completed successfully.';
        } catch (e) {
            // Fallback response if synthesis fails
            if (executionResult && executionResult.response) {
                return executionResult.response;
            }
            return 'Task completed.';
        }
    }
}

// Singleton instance
export const aiBrain = new AIBrain();
