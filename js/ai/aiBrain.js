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
 *   - Interaction context (Part 4) is caller-supplied metadata only: it is
 *     never detected or inferred here, and it grants no permissions and
 *     bypasses PlanValidator / the Permission Gateway
 */
import { CONFIG } from '../config.js';
import { state } from '../state.js';
import { ModelAdapter, AIError, AIValidationError } from './modelAdapter.js';
import { AI_OUTCOME, classifyAiError, formatAiDiagnostic, tagAiStage } from './aiOutcome.js';
import { MockAdapter } from './mockAdapter.js';
import { HttpModelAdapter } from './httpModelAdapter.js';
import { planValidator as defaultPlanValidator } from './planValidator.js';
import { toolDiscovery as defaultToolDiscovery } from './toolDiscovery.js';
import { memoryAdapter as defaultMemoryAdapter } from './memoryAdapter.js';
import { contextBuilder as defaultContextBuilder } from './contextBuilder.js';

/**
 * Part 4 — explicit ContextBuilder input boundary.
 *
 * These are the pre-existing option fields on processRequest()/generatePlan()
 * that are intended for ContextBuilder (Part 3 accepted them; they keep
 * working). Anything else on the options object (timeout, signal,
 * adapter-specific keys) is a model-adapter option and must never become a
 * context-builder field — so the request path forwards only these keys
 * instead of spreading arbitrary options into buildContext().
 *
 * `interactionContext` is deliberately NOT part of this list: it is passed
 * through explicitly (and by reference) alongside this selection, per the
 * Part 4 contract.
 */
const CONTEXT_BUILDER_OPTION_KEYS = Object.freeze([
    'historyLimit',
    'memoryLimit',
    'includeTools',
    'includeMemory',
    'includeHistory',
    'includeTaskState'
]);

/**
 * Pick only the recognized ContextBuilder fields from an options object.
 * Pure and non-mutating: returns a fresh object; the input is never modified.
 *
 * @param {Object} [options]
 * @returns {Object} Only the ContextBuilder fields that were supplied
 */
function pickContextBuilderOptions(options = {}) {
    const picked = {};
    const source = (options !== null && typeof options === 'object') ? options : {};
    for (const key of CONTEXT_BUILDER_OPTION_KEYS) {
        if (source[key] !== undefined) {
            picked[key] = source[key];
        }
    }
    return picked;
}

/** True for a string with at least one non-whitespace character. */
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

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
     * @param {Object} [options.interactionContext] - Explicit caller-supplied
     *     interaction metadata (Part 4). Forwarded to ContextBuilder unchanged
     *     (same reference). AIBrain performs NO detection, inference,
     *     selection, or normalization of it — normalization/defaults belong
     *     solely to the Part 2 createInteractionContext() factory inside
     *     ContextBuilder. This is metadata only: it grants no permissions and
     *     bypasses no validation.
     * @param {number} [options.timeout] - Model-adapter timeout in ms
     * @param {AbortSignal} [options.signal] - Model-adapter cancellation signal
     * @param {...*} [options] - Additional model-adapter options are forwarded
     *     to adapter.generate(); ContextBuilder fields (historyLimit,
     *     memoryLimit, includeTools, includeMemory, includeHistory,
     *     includeTaskState) keep working as before.
     * @returns {Promise<Object>} Processed result. Every result carries an
     *     `outcome` (an AI_OUTCOME category) and, on failure, the pipeline
     *     `stage` where it occurred. Success is `CONVERSATION` (a valid direct
     *     natural-language answer) or `PLAN` (a validated action plan); every
     *     other outcome is a failure that the caller must handle explicitly —
     *     a failure is never presented as an AI answer.
     *     A validated multi-step result additionally carries `context`: the
     *     already-built ContextBuilder context for this request (returned
     *     as-is, never rebuilt or mutated), so the caller can hand the SAME
     *     context to generateResponse() after the Agent executes the plan.
     */
    async processRequest(request, options = {}) {
        const text = String(request || '').trim();

        if (!text) {
            return {
                success: false,
                isMultiStep: false,
                response: 'Please provide a request or instruction.',
                error: 'Empty request',
                outcome: AI_OUTCOME.INVALID_REQUEST,
                stage: 'input'
            };
        }

        if (!this.isEnabled()) {
            return {
                success: false,
                disabled: true,
                fallback: true,
                error: 'AI Brain is currently disabled',
                outcome: AI_OUTCOME.DISABLED,
                stage: 'input'
            };
        }

        let stage = 'context';
        try {
            // 1. Build bounded context through an explicit ContextBuilder
            //    input boundary (Part 4). Only the fields ContextBuilder
            //    understands are forwarded — never an accidental spread of
            //    arbitrary options, so model-adapter options (timeout,
            //    signal, adapter-specific keys) cannot become context fields.
            //    `interactionContext` is passed through exactly as supplied
            //    (same reference, no mutation, no detection, no normalization
            //    here): ContextBuilder's Part 2 factory remains the single
            //    normalization boundary.
            const context = this._contextBuilder.buildContext({
                request: text,
                interactionContext: options.interactionContext,
                ...pickContextBuilderOptions(options)
            });

            // 2. Generate structured plan or response via adapter
            stage = 'generate';
            const generation = await this.generatePlan(text, context, options);

            // 3. Handle generated multi-step plan
            if (generation.isPlan && generation.plan) {
                // Validate plan strictly with PlanValidator
                stage = 'validate';
                const validation = this._validator.validate(generation.plan);

                if (!validation.valid) {
                    // Count only: the individual messages quote model-supplied values.
                    const issues = validation.errors.length;
                    state.logActivity(`AI plan rejected by Plan Validator (${issues} issue${issues === 1 ? '' : 's'})`, 'warning');
                    return {
                        success: false,
                        fallback: true,
                        error: `Invalid AI plan: ${validation.errors.join('; ')}`,
                        validationErrors: validation.errors,
                        outcome: AI_OUTCOME.INVALID_OUTPUT,
                        stage
                    };
                }

                return {
                    success: true,
                    isMultiStep: true,
                    goal: text,
                    plan: validation.normalizedPlan,
                    // Part 9B: the ContextBuilder context that produced this
                    // plan is retained on the result — the same object, never
                    // rebuilt and never mutated — so the post-execution final
                    // synthesis can reuse it instead of building a second,
                    // independent context.
                    context,
                    raw: generation.raw,
                    outcome: AI_OUTCOME.PLAN,
                    stage
                };
            }

            // 4. A mock/offline generation is never a model answer, so it is
            //    reported as OFFLINE and can never be presented as one.
            if (generation.offline) {
                return {
                    success: false,
                    fallback: true,
                    offline: true,
                    error: 'No live AI model is connected',
                    outcome: AI_OUTCOME.OFFLINE,
                    stage
                };
            }

            // 5. Handle direct natural language response
            if (generation.isDirectResponse) {
                return {
                    success: true,
                    isMultiStep: false,
                    response: generation.response,
                    raw: generation.raw,
                    outcome: AI_OUTCOME.CONVERSATION,
                    stage
                };
            }

            // Fallback if neither
            return {
                success: false,
                fallback: true,
                error: 'AI did not produce a recognizable plan or response',
                outcome: AI_OUTCOME.INVALID_OUTPUT,
                stage
            };
        } catch (err) {
            // The failing stage is tagged where it happened (generatePlan tags
            // adapter and parse errors); otherwise it is the stage we reached.
            // The raw message is never logged here: parser and provider messages
            // can quote model output or user text. The caller logs the stage,
            // category and fixed code via formatAiDiagnostic().
            const failedStage = err?.aiStage || stage;
            const failure = this._describeFailure(err, failedStage);

            return {
                success: false,
                fallback: true,
                error: failure.message,
                code: failure.code,
                outcome: failure.kind,
                stage: failedStage
            };
        }
    }

    /**
     * Map a thrown error to a categorized failure. Errors raised by the
     * adapter are normalized into the AI error hierarchy first; any error
     * that is not part of that hierarchy and did not come from the adapter is
     * a local INTERNAL fault, never a provider fault.
     *
     * @param {*} err
     * @param {string} stage
     * @returns {{ kind: string, code: string, message: string }}
     */
    _describeFailure(err, stage) {
        let aiError = err instanceof AIError ? err : null;
        if (!aiError && stage === 'generate') {
            aiError = this._adapter.normalizeError(err);
        }
        if (aiError) {
            const { kind, code } = classifyAiError(aiError);
            return { kind, code, message: aiError.message };
        }
        return {
            kind: AI_OUTCOME.INTERNAL,
            code: 'INTERNAL',
            message: 'AI Brain encountered an unexpected error'
        };
    }

    /**
     * Generate a structured plan for a goal.
     *
     * When an already-built context is supplied it is used exactly as-is:
     * never rebuilt, and its interactionContext is never overwritten. When
     * AIBrain builds the context itself, the caller-supplied
     * options.interactionContext is forwarded to ContextBuilder unchanged —
     * AIBrain adds no detection, selection, or normalization of its own.
     *
     * @param {string} goal
     * @param {Object} [context] - Already-built context (used as-is if given)
     * @param {Object} [options]
     * @param {Object} [options.interactionContext] - Explicit interaction metadata (Part 4)
     * @returns {Promise<{ isPlan: boolean, plan?: Object, isDirectResponse?: boolean, response?: string, raw: any }>}
     */
    async generatePlan(goal, context = null, options = {}) {
        // Preserve an already-built context untouched; otherwise build one,
        // forwarding interactionContext explicitly (same pass-through rule as
        // processRequest — ContextBuilder normalizes, AIBrain does not).
        const fullContext = context || this._contextBuilder.buildContext({
            request: goal,
            interactionContext: options.interactionContext
        });
        const prompt = this._contextBuilder.formatForPrompt(fullContext);

        // `interactionContext` is prompt-context metadata consumed by
        // ContextBuilder — it is not a model-adapter control — so it is the
        // one option deliberately kept out of the adapter call. Every other
        // option (timeout, signal, adapter-specific keys) flows through
        // unchanged, preserving the existing adapter-options contract.
        const { interactionContext: _interactionContext, ...adapterOptions } = options;

        let result;
        try {
            result = await this._adapter.generate(prompt, {
                responseFormat: 'plan',
                timeout: options.timeout || CONFIG.ai?.timeout || 5000,
                signal: options.signal || null,
                ...adapterOptions
            });
        } catch (err) {
            // Structured-output rejections raised by the adapter are parse
            // failures; everything else from the adapter is a generation failure.
            throw tagAiStage(err, err instanceof AIValidationError ? 'parse' : 'generate');
        }

        if (!result || typeof result !== 'object') {
            throw tagAiStage(new AIValidationError('Model adapter returned empty result'), 'generate');
        }

        // Offline (mock) generations are reported so the caller never presents
        // their text as a model answer. Their structured plans are still
        // validated like any other plan.
        const offline = result.offline === true;

        // If structured output is already present
        if (result.structured && typeof result.structured === 'object') {
            if (Array.isArray(result.structured.steps)) {
                return {
                    isPlan: true,
                    plan: result.structured,
                    raw: result,
                    offline
                };
            }
            if (result.structured.response !== undefined) {
                if (!isNonEmptyString(result.structured.response)) {
                    throw tagAiStage(new AIValidationError('Direct response must be a non-empty string'), 'parse');
                }
                return {
                    isDirectResponse: true,
                    response: result.structured.response,
                    raw: result,
                    offline
                };
            }
        }

        // Attempt to parse structured output from raw text
        if (isNonEmptyString(result.text)) {
            let parsed;
            try {
                parsed = this._adapter.parseStructuredOutput(result.text);
            } catch (err) {
                // Offline text is never a model answer, even when it does not parse.
                if (offline) return { offline: true, raw: result };
                throw tagAiStage(err, 'parse');
            }
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.steps)) {
                return {
                    isPlan: true,
                    plan: parsed,
                    raw: result,
                    offline
                };
            }
            if (parsed && typeof parsed === 'object' && isNonEmptyString(parsed.response)) {
                return {
                    isDirectResponse: true,
                    response: parsed.response,
                    raw: result,
                    offline
                };
            }
            if (offline) return { offline: true, raw: result };
            throw tagAiStage(
                new AIValidationError('Parsed JSON output did not contain valid plan steps or response'),
                'parse'
            );
        }

        // An empty generation is a failure, never a successful "Understood." reply.
        if (offline) return { offline: true, raw: result };
        throw tagAiStage(
            new AIValidationError('Model adapter returned no usable text or structured output'),
            'parse'
        );
    }

    /**
     * Synthesize a natural-language response given user request, execution results, and context.
     *
     * Part 9B — context-aware final response synthesis.
     *
     * The final synthesis step now receives the same ALICE context the planning
     * step used:
     *   - a supplied `context` is formatted exactly as-is through the existing
     *     ContextBuilder — it is never rebuilt and never mutated;
     *   - when no context is supplied, a minimal context is built from the
     *     request through that same ContextBuilder, so the established prompt
     *     sections (ALICE Identity, Interaction Context, Emotional Response
     *     Guidance, Response Priority Contract, presentation-only response
     *     contract, tools/memory/history/task state) exist either way.
     *
     * AIBrain still detects, infers, and normalizes nothing: the caller-supplied
     * `options.interactionContext` is only forwarded, and ContextBuilder remains
     * the single normalization boundary.
     *
     * This step asks for `responseFormat: 'text'` and a single user-facing
     * natural-language reply (no JSON envelope, plan, tool calls, or execution).
     * The structured JSON planning contract in generatePlan() is untouched.
     *
     * @param {string} request - The user's original request (authoritative)
     * @param {Object} executionResult - Factual result produced by ALICE's tools
     * @param {Object} [context] - Already-built context (used as-is if given)
     * @param {Object} [options]
     * @param {Object} [options.interactionContext] - Explicit interaction
     *     metadata (Part 4): forwarded unchanged when building a context, and
     *     never forwarded to the model adapter.
     * @returns {Promise<string>}
     */
    async generateResponse(request, executionResult, context = null, options = {}) {
        // Preserve an already-built context untouched; otherwise build a
        // minimal one from the request (same pass-through rule as
        // generatePlan — ContextBuilder normalizes, AIBrain does not).
        const fullContext = context || this._contextBuilder.buildContext({
            request,
            interactionContext: options.interactionContext
        });

        // Reuse the same ContextBuilder context, but never inherit its JSON
        // planning instructions as the final response's output contract.
        const formattedContext = this._contextBuilder.formatForPrompt(fullContext, {
            responseContract: 'presentation'
        });

        // The user's request stays authoritative; the execution result is
        // factual task data. This step returns natural language only.
        const prompt = [
            formattedContext,
            'Final Response Synthesis (this step only):\n' +
            "- The user's request is the primary task: answer it exactly as asked.\n" +
            '- The ALICE context above informs awareness and communication style only.\n' +
            '- The Execution Result is factual output produced for that request: report it accurately and never let it replace or reinterpret the request.\n' +
            '- Reply with the final user-facing natural-language response only: no JSON, no plan, no Markdown code fences, and no internal reasoning or process narration.',
            `User Request: "${request}"`,
            `Execution Result: ${JSON.stringify(executionResult)}`
        ].join('\n\n');

        // `interactionContext` is prompt-context metadata consumed by
        // ContextBuilder — it is not a model-adapter control — so it is the one
        // option deliberately kept out of the adapter call. Every other option
        // (timeout, signal, adapter-specific keys) flows through unchanged,
        // preserving the existing adapter-options contract.
        const { interactionContext: _interactionContext, ...adapterOptions } = options;

        try {
            const result = await this._adapter.generate(prompt, {
                responseFormat: 'text',
                timeout: options.timeout || CONFIG.ai?.timeout || 5000,
                signal: options.signal || null,
                ...adapterOptions
            });

            // Offline (mock) text is not a model's synthesis of the result.
            // Keep the factual execution report instead of presenting it as
            // the final answer.
            if (result && result.offline === true) {
                return executionResult?.response || 'Task completed.';
            }

            return result.text || 'Task completed successfully.';
        } catch (e) {
            // Categorized, content-free diagnostic; the factual result is kept.
            const { kind, code } = classifyAiError(e);
            state.logActivity(formatAiDiagnostic({ label: 'AI Brain synthesis error', stage: 'synthesize', kind, code }), 'warning');
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
