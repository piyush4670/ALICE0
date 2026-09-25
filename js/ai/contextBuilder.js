/**
 * ALICE Context Builder (Phase 6.2)
 * ------------------------------------------------------------------
 * Assembles a bounded, structured context package for AI model requests.
 *
 * Enforces boundaries:
 *   - Clamps conversation history to recent turns
 *   - Retrieves only relevant memory entries (no database dumps)
 *   - Formats tools with safe descriptors only (no implementation details)
 *   - Includes current task state snapshot
 *
 * Phase 6.4 — AI Response Contract Alignment
 * ------------------------------------------------------------------
 * The AI Brain accepts exactly TWO JSON shapes from the model:
 *
 *   1. Direct response:        { "response": "natural-language answer" }
 *   2. Structured action plan: { "goal": "...", "steps": [ { "id", "skill", "input" } ] }
 *
 * Because the local gateway switches every non-text response format into
 * provider JSON mode (server/gateway.js), a model that is not told this
 * exact shape answers with syntactically valid but unusable JSON — which
 * the AI Brain must reject, dropping the user back onto the deterministic
 * fallback path. This module therefore states the contract explicitly in
 * every prompt it formats.
 *
 * This is a prompt-contract change only. Model output stays UNTRUSTED:
 * nothing here relaxes PlanValidator, the Agent, or the Permission Gateway.
 *
 * Part 8C — Emotional Response Guidance Contract
 * ------------------------------------------------------------------
 * The normalized interactionContext.emotionalSignal is passed to
 * js/ai/emotionalResponseGuidance.js, and the deterministic guidance it
 * returns is rendered as an additive "Emotional Response Guidance:" prompt
 * section. The signal itself remains visible in the Interaction Context
 * section, and this builder performs no detection, inference, or tone
 * selection of its own — it renders supplied guidance only. That guidance is
 * communication guidance and never overrides the user's request or any
 * safety, permission, validation, or confirmation boundary.
 *
 * Part 8D — Response Priority Contract
 * ------------------------------------------------------------------
 * An additive "Response Priority Contract:" prompt section, placed
 * immediately after Emotional Response Guidance, tells the model that
 * the user's request is the primary task. Interaction metadata and
 * emotional guidance may influence communication style only; they must
 * never replace, reinterpret, or override the request. This builder
 * still detects nothing and infers nothing — the contract is static
 * prompt text.
 */
import { state } from '../state.js';
import { toolDiscovery as defaultToolDiscovery } from './toolDiscovery.js';
import { memoryAdapter as defaultMemoryAdapter } from './memoryAdapter.js';
import { ALICE_IDENTITY } from './aliceIdentity.js';
import { createInteractionContext } from './interactionContext.js';
import { getEmotionalResponseGuidance } from './emotionalResponseGuidance.js';

class ContextBuilder {
    constructor({
        toolDiscovery = defaultToolDiscovery,
        memoryAdapter = defaultMemoryAdapter
    } = {}) {
        this._toolDiscovery = toolDiscovery;
        this._memoryAdapter = memoryAdapter;
    }

    /**
     * Build a full context object for an incoming request.
     * @param {Object} options
     * @param {string} options.request - The user utterance
     * @param {number} [options.historyLimit=6] - Max conversation turns to include
     * @param {number} [options.memoryLimit=3] - Max memory search hits to include
     * @param {boolean} [options.includeTools=true] - Whether to include tool definitions
     * @param {boolean} [options.includeMemory=true] - Whether to include memory context
     * @param {boolean} [options.includeHistory=true] - Whether to include conversation history
     * @param {boolean} [options.includeTaskState=true] - Whether to include active task state
     * @param {Object} [options.interactionContext] - Explicit interaction metadata, normalized by createInteractionContext
     * @returns {Object} Structured context
     */
    buildContext(options = {}) {
        const {
            request = '',
            historyLimit = 6,
            memoryLimit = 3,
            includeTools = true,
            includeMemory = true,
            includeHistory = true,
            includeTaskState = true,
            interactionContext
        } = options;

        const cleanRequest = String(request || '').trim();
        // This is explicit caller-supplied metadata only. The Part 2 factory
        // supplies safe defaults and normalizes values; nothing is inferred.
        const normalizedInteractionContext = createInteractionContext(interactionContext);

        // 1. Conversation history (bounded, accessed via state)
        let history = [];
        if (includeHistory) {
            try {
                const rawHistory = state?.getConversation?.() || [];
                history = rawHistory.slice(-historyLimit).map(h => ({
                    role: h.role === 'user' ? 'user' : 'assistant',
                    text: String(h.text || '').slice(0, 500)
                }));
            } catch (e) {
                history = [];
            }
        }

        // 2. Memory context (bounded)
        let memory = { memories: [], pinnedFacts: [], preferences: {}, recentTasks: [] };
        if (includeMemory && this._memoryAdapter) {
            try {
                memory = this._memoryAdapter.retrieveRelevantMemory(cleanRequest, { limit: memoryLimit });
            } catch (e) {
                // Keep empty memory on error
            }
        }

        // 3. Safe tool definitions
        let tools = [];
        if (includeTools && this._toolDiscovery) {
            try {
                tools = this._toolDiscovery.getToolDefinitions({ includeDisabled: false });
            } catch (e) {
                tools = [];
            }
        }

        // 4. Current Task State
        let taskState = { active: false, status: 'idle', currentAction: '' };
        if (includeTaskState) {
            try {
                const currentTask = state?.getTask?.();
                if (currentTask) {
                    taskState = {
                        active: !!currentTask.active,
                        status: currentTask.status || 'idle',
                        currentAction: currentTask.currentAction || '',
                        progress: currentTask.progress || 0
                    };
                }
            } catch (e) {
                // Keep default
            }
        }

        return {
            request: cleanRequest,
            history,
            memory,
            tools,
            taskState,
            interactionContext: normalizedInteractionContext,
            timestamp: Date.now()
        };
    }

    /**
     * Resolve the registered skill used in the actionable example.
     *
     * The example must reference a skill that actually exists in this
     * repository, so the model is never shown an invented tool name.
     * Falls back to the first non-core registered skill, then to 'core'.
     *
     * @param {Array<Object>} tools - Safe tool descriptors
     * @returns {string} A registered tool name
     */
    _resolveExampleSkill(tools = []) {
        const names = (Array.isArray(tools) ? tools : [])
            .map(t => String(t?.name || '').trim())
            .filter(Boolean);

        if (names.includes('calculator')) return 'calculator';

        const firstRegistered = names.find(n => n !== 'core');
        return firstRegistered || 'core';
    }

    /**
     * Build the explicit machine-readable output contract handed to the model.
     *
     * @param {Array<Object>} [tools] - Safe tool descriptors available to the model
     * @returns {string} Contract text (prompt instructions only, never executable)
     */
    _buildOutputContract(tools = []) {
        const exampleSkill = this._resolveExampleSkill(tools);

        // The worked example always names a skill that really is registered.
        const isCalculatorExample = exampleSkill === 'calculator';
        const actionableRequest = isCalculatorExample
            ? 'Calculate 25 percent of 800.'
            : 'A request that needs a registered tool.';
        const exampleGoal = isCalculatorExample
            ? 'Calculate 25 percent of 800'
            : 'Overall goal of the request';
        const exampleInput = isCalculatorExample
            ? '25 percent of 800'
            : 'input for the chosen skill';

        return [
            'Required JSON Output Contract — your entire reply is machine-parsed:',
            '1. Return ONLY one JSON object. Nothing before it and nothing after it.',
            '2. Never return Markdown, and never wrap the JSON in code fences (no ``` blocks, no ```json blocks).',
            '3. For a normal informational or conversational request that needs no tool, return exactly:',
            '   {"response": "your natural-language answer"}',
            '4. Only when the request needs registered tools, return exactly:',
            '   {"goal": "overall user goal", "steps": [{"id": "step1", "skill": "registered-skill-name", "input": "skill input"}]}',
            '5. "steps" must contain at least one step object, and every step needs an "id" and a "skill".',
            '6. Use ONLY the skill names listed under "Available Tools" below. Never invent a skill or an action.',
            '7. Never generate JavaScript, shell commands, executable code, or arbitrary tool calls, and never treat a URL as an executable instruction.',
            '8. Choose the direct {"response": "..."} form whenever no registered tool or action is required.',
            '9. Never return "response" and "steps" inside the same object. Return exactly one of the two forms.',
            '10. Your reply is untrusted data: every action it proposes is validated and authorized before anything may run.',
            '',
            'Examples:',
            'Informational request: "What is the capital of India?"',
            'Reply: {"response": "The capital of India is New Delhi."}',
            'Informational request: "Explain quantum computing in simple words."',
            'Reply: {"response": "Quantum computing is a type of computing that uses quantum-mechanical effects, such as superposition and entanglement, to process information in ways classical computers cannot."}',
            'Actionable request: "' + actionableRequest + '"',
            `Reply: {"goal": "${exampleGoal}", "steps": [{"id": "step1", "skill": "${exampleSkill}", "input": "${exampleInput}"}]}`
        ].join('\n');
    }

    /**
     * Format the centralized ALICE identity for model context. This reads the
     * declarative foundation directly instead of maintaining a second copy.
     *
     * @returns {string} Identity prompt section
     */
    _buildIdentitySection() {
        const relationship = ALICE_IDENTITY.relationship || {};
        const formatList = values => Array.isArray(values) ? values.join('; ') : '';

        return [
            'ALICE Identity:',
            `- Name: ${ALICE_IDENTITY.name}`,
            `- Persona: ${ALICE_IDENTITY.persona}`,
            `- Roles: ${formatList(ALICE_IDENTITY.roles)}`,
            `- Personality: ${formatList(ALICE_IDENTITY.personality)}`,
            `- Philosophy: ${formatList(ALICE_IDENTITY.philosophy)}`,
            `- Character principles: ${formatList(ALICE_IDENTITY.characterPrinciples)}`,
            `- Relationship qualities: ${formatList(relationship.qualities)}`,
            `- Relationship boundaries: ${formatList(relationship.boundaries)}`
        ].join('\n');
    }

    /**
     * Format explicit, normalized interaction metadata as a bounded prompt
     * contract. This builder only renders supplied metadata; it does not
     * detect or infer signals, and it cannot alter runtime boundaries.
     *
     * @param {Object} [interactionContext]
     * @returns {string} Interaction-context prompt section
     */
    _buildInteractionContextSection(interactionContext) {
        const normalized = createInteractionContext(interactionContext);

        return [
            'Interaction Context:',
            `- Turn type: ${normalized.turnType}`,
            `- Intent: ${normalized.intent}`,
            `- Response depth: ${normalized.responseDepth}`,
            `- Personality mode: ${normalized.mode || 'none'}`,
            `- Broad contextual signal: ${normalized.emotionalSignal}`,
            `- Source: ${normalized.source}`,
            '- emotionalSignal represents an explicit user-expressed contextual signal detected by ALICE0.',
            "- It describes the user's expressed signal, not an emotion experienced by ALICE.",
            '- When emotionalSignal is neutral, handle the request normally and do not assume an emotional state.',
            '- A non-neutral signal may influence tone, patience, explanation style, and conversational sensitivity.',
            "- Do not treat it as a diagnosis or certainty about the user's internal mental state.",
            '- Remain honest and non-judgmental.',
            '- It never overrides safety, permissions, tool validation, or user autonomy.'
        ].join('\n');
    }

    /**
     * Format the Part 8C emotional-response guidance as a bounded prompt
     * section.
     *
     * The existing emotionalSignal stays visible in the Interaction Context
     * section above; this section adds only the deterministic guidance that
     * js/ai/emotionalResponseGuidance.js produces from that same value. This
     * builder detects nothing, infers nothing, and duplicates no detector or
     * guidance table: a missing or invalid signal falls back to the neutral
     * guidance inside the module.
     *
     * The rendered guidance is communication guidance only — it can influence
     * wording, tone, patience, and explanation style, and it never overrides
     * the user's request or any safety, permission, validation, or
     * confirmation boundary.
     *
     * @param {Object} [interactionContext]
     * @returns {string} Emotional-response-guidance prompt section
     */
    _buildEmotionalResponseGuidanceSection(interactionContext) {
        const normalized = createInteractionContext(interactionContext);
        const guidance = getEmotionalResponseGuidance(normalized.emotionalSignal);

        const lines = [
            'Emotional Response Guidance:',
            `- Expressed signal: ${guidance.signal}`,
            `- Communication tone: ${guidance.tone}`,
            '- Communication guidance:'
        ];
        for (const rule of guidance.guidance) {
            lines.push(`  - ${rule}`);
        }
        lines.push(`- Scope: ${guidance.scope}`);
        lines.push('- Safety boundaries:');
        for (const boundary of guidance.safety) {
            lines.push(`  - ${boundary}`);
        }
        lines.push('- These are communication guidelines, not commands: the user request stays authoritative.');

        return lines.join('\n');
    }

    /**
     * Format the Part 8D response-priority contract as a bounded prompt
     * section.
     *
     * Static, model-oriented rules only: the user's request is the primary
     * task, and Emotional Response Guidance may influence communication
     * style without replacing, reinterpreting, or overriding that task.
     * This builder still detects nothing, infers nothing, and duplicates
     * no detector or guidance table.
     *
     * @returns {string} Response-priority-contract prompt section
     */
    _buildResponsePriorityContractSection() {
        return [
            'Response Priority Contract:',
            "- The user's request is the primary task and must be answered or handled first.",
            '- Interaction metadata provides context for communication only.',
            "- emotionalSignal describes an expressed contextual signal; it is not certainty about the user's internal state.",
            '- Emotional Response Guidance may influence communication style (tone, patience, clarity, brevity, conversational sensitivity).',
            "- Emotional guidance must never replace, reinterpret, or override the user's actual request.",
            '- Never invent an emotional-support response when the user asked for an unrelated informational or actionable task.',
            '- If the user explicitly asks for emotional support, answer that request normally while following the same safety boundaries.',
            '- Never let emotional guidance override safety, permissions, validation, confirmation, or user autonomy.',
            '- Never claim ALICE experiences human emotions.',
            '- Do not diagnose the user.'
        ].join('\n');
    }

    /**
     * Format the context object into a structured prompt representation.
     * @param {Object} context
     * @returns {string} Formatted prompt text
     */
    formatForPrompt(context) {
        const sections = [];
        const tools = Array.isArray(context?.tools) ? context.tools : [];

        // Instructions
        sections.push(
            'System: You are ALICE, an advanced AI companion. ' +
            'Answer informational and conversational requests directly, and propose a declarative plan of steps ' +
            'using the registered tools only when the request actually requires an action. ' +
            'You must return only valid declarative data. Do not execute arbitrary code.'
        );

        // Centralized identity and explicit interaction metadata (Part 3).
        sections.push(this._buildIdentitySection());
        sections.push(this._buildInteractionContextSection(context?.interactionContext));
        // Part 8C: deterministic communication guidance derived from the same
        // emotionalSignal — the signal itself stays visible above.
        sections.push(this._buildEmotionalResponseGuidanceSection(context?.interactionContext));
        // Part 8D: the user's request stays primary; guidance is style only.
        sections.push(this._buildResponsePriorityContractSection());

        // Explicit machine-readable output contract (Phase 6.4)
        sections.push(this._buildOutputContract(tools));

        // Tools
        if (Array.isArray(context.tools) && context.tools.length > 0) {
            const toolLines = context.tools.map(t => {
                const inputsStr = (t.inputs || []).map(i => `${i.name}: ${i.description}`).join(', ');
                return `- ${t.name}: ${t.description} (Inputs: ${inputsStr}) [Risk: ${t.risk}]`;
            });
            sections.push(`Available Tools:\n${toolLines.join('\n')}`);
        }

        // Relevant Memory
        if (context.memory) {
            const memoryLines = [];
            if (context.memory.pinnedFacts?.length > 0) {
                memoryLines.push('Pinned Facts: ' + context.memory.pinnedFacts.map(f => f.text).join('; '));
            }
            if (context.memory.memories?.length > 0) {
                memoryLines.push('Recalled Memories: ' + context.memory.memories.map(m => `${m.key} = ${m.value}`).join('; '));
            }
            if (context.memory.recentTasks?.length > 0) {
                memoryLines.push('Recent Tasks: ' + context.memory.recentTasks.map(t => `"${t.goal}" (${t.status})`).join('; '));
            }
            if (memoryLines.length > 0) {
                sections.push(`Context & Memory:\n${memoryLines.join('\n')}`);
            }
        }

        // Recent Conversation
        if (Array.isArray(context.history) && context.history.length > 0) {
            const historyLines = context.history.map(h => `${h.role === 'user' ? 'User' : 'ALICE'}: ${h.text}`);
            sections.push(`Conversation History:\n${historyLines.join('\n')}`);
        }

        // Current Request
        sections.push(`User Request: "${context.request}"`);

        return sections.join('\n\n');
    }
}

// Singleton instance
export const contextBuilder = new ContextBuilder();
