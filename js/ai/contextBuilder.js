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
 */
import { state } from '../state.js';
import { toolDiscovery as defaultToolDiscovery } from './toolDiscovery.js';
import { memoryAdapter as defaultMemoryAdapter } from './memoryAdapter.js';

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
            includeTaskState = true
        } = options;

        const cleanRequest = String(request || '').trim();

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
            timestamp: Date.now()
        };
    }

    /**
     * Format the context object into a structured prompt representation.
     * @param {Object} context
     * @returns {string} Formatted prompt text
     */
    formatForPrompt(context) {
        const sections = [];

        // Instructions
        sections.push(
            'System: You are ALICE, an advanced AI companion. ' +
            'Analyze the user request and propose a structured plan of steps using the available tools. ' +
            'You must return only valid declarative actions. Do not execute arbitrary code.'
        );

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
