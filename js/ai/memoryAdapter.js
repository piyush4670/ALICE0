/**
 * ALICE Memory Adapter for AI Brain (Phase 6.2)
 * ------------------------------------------------------------------
 * Provides an abstract interface for the AI Brain to request relevant
 * memory context without tight coupling to the underlying storage implementation.
 *
 * Enforces safety boundaries:
 *   - NEVER dumps the entire memory database into prompt context
 *   - Queries are bounded to top-K most relevant entries
 *   - Results are sanitized before passing to context builders
 */
import { memory as defaultMemory } from '../memory.js';

class MemoryAdapter {
    constructor(memorySystem = defaultMemory) {
        this._memory = memorySystem;
    }

    /**
     * Retrieve relevant memory context for a given query or task.
     * @param {string} query - The user request or topic
     * @param {Object} [options]
     * @param {number} [options.limit=3] - Maximum long-term memories to return
     * @param {boolean} [options.includePinned=true] - Include pinned facts
     * @param {boolean} [options.includePreferences=true] - Include preferences
     * @param {boolean} [options.includeRecentTasks=true] - Include recent task summaries
     * @returns {Object} Structured relevant memory
     */
    retrieveRelevantMemory(query = '', options = {}) {
        const {
            limit = 3,
            includePinned = true,
            includePreferences = true,
            includeRecentTasks = true
        } = options;

        const result = {
            memories: [],
            pinnedFacts: [],
            preferences: {},
            recentTasks: []
        };

        if (!this._memory) return result;

        const q = String(query || '').trim();

        // 1. Query-relevant long term memories (scored search, bounded)
        if (q && typeof this._memory.search === 'function') {
            try {
                const searchResults = this._memory.search(q);
                if (Array.isArray(searchResults)) {
                    result.memories = searchResults.slice(0, limit).map(m => ({
                        key: String(m.key || ''),
                        value: String(m.value || ''),
                        score: Number(m.score) || 0
                    }));
                }
            } catch (e) {
                // Fail gracefully without crashing
                result.memories = [];
            }
        }

        // 2. Pinned facts (bounded)
        if (includePinned && typeof this._memory.getPinnedFacts === 'function') {
            try {
                const facts = this._memory.getPinnedFacts();
                if (Array.isArray(facts)) {
                    result.pinnedFacts = facts.slice(0, 3).map(f => ({
                        id: String(f.id || ''),
                        text: String(f.text || '')
                    }));
                }
            } catch (e) {
                result.pinnedFacts = [];
            }
        }

        // 3. Preferences
        if (includePreferences && typeof this._memory.getAllPreferences === 'function') {
            try {
                const prefs = this._memory.getAllPreferences();
                if (prefs && typeof prefs === 'object') {
                    // Safe shallow copy of preferences
                    result.preferences = { ...prefs };
                }
            } catch (e) {
                result.preferences = {};
            }
        }

        // 4. Recent completed task history (bounded)
        if (includeRecentTasks && typeof this._memory.getTaskHistory === 'function') {
            try {
                const tasks = this._memory.getTaskHistory(3);
                if (Array.isArray(tasks)) {
                    result.recentTasks = tasks.map(t => ({
                        goal: String(t.goal || ''),
                        status: String(t.status || ''),
                        summary: String(t.summary || '')
                    }));
                }
            } catch (e) {
                result.recentTasks = [];
            }
        }

        return result;
    }

    /**
     * Store a memory through the adapter.
     */
    remember(key, value) {
        if (this._memory && typeof this._memory.remember === 'function') {
            this._memory.remember(key, value);
        }
    }

    /**
     * Recall a specific memory key.
     */
    recall(key) {
        if (this._memory && typeof this._memory.recall === 'function') {
            return this._memory.recall(key);
        }
        return null;
    }
}

// Singleton instance
export const memoryAdapter = new MemoryAdapter();
