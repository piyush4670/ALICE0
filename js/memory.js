/**
 * ALICE Memory System
 * Handles short-term context and user-controlled long-term memory
 * Uses localStorage for persistence
 */
import { state } from './state.js';

class MemorySystem {
    constructor() {
        this._shortTerm = []; // Conversation context
        this._longTerm = new Map(); // User-controlled memories
        this._notes = []; // Saved notes
        this._reminders = []; // Tasks/reminders
        this._preferences = {}; // User preferences (Part 5)
        this._projectContext = {}; // Per-project context (Part 5)
        this._pinnedFacts = []; // Important pinned facts (Part 5)
        this._taskHistory = []; // Completed task history (Part 5)
        this._maxShortTerm = 20;
        this._storageKey = 'alice_memory';
        
        this._load();
        this._startReminderChecker();
    }

    /**
     * Load memory from localStorage
     */
    _load() {
        try {
            const stored = localStorage.getItem(this._storageKey);
            if (stored) {
                const data = JSON.parse(stored);
                this._longTerm = new Map(data.longTerm || []);
                this._notes = data.notes || [];
                this._reminders = data.reminders || [];
                this._preferences = data.preferences || {};
                this._projectContext = data.projectContext || {};
                this._pinnedFacts = data.pinnedFacts || [];
                this._taskHistory = data.taskHistory || [];
                
                // Clean up old reminders
                this._cleanReminders();
            }
        } catch (e) {
            console.warn('Failed to load memory:', e);
        }
    }

    /**
     * Save memory to localStorage
     */
    _save() {
        try {
            const data = {
                longTerm: Array.from(this._longTerm.entries()),
                notes: this._notes,
                reminders: this._reminders,
                preferences: this._preferences,
                projectContext: this._projectContext,
                pinnedFacts: this._pinnedFacts,
                taskHistory: this._taskHistory
            };
            localStorage.setItem(this._storageKey, JSON.stringify(data));
            state.notifyMemoryChanged();
        } catch (e) {
            console.warn('Failed to save memory:', e);
        }
    }

    // ============ SHORT-TERM MEMORY ============

    /**
     * Add to short-term context
     */
    addToContext(text, role = 'user') {
        this._shortTerm.push({
            role,
            text,
            timestamp: Date.now()
        });

        // Keep only recent context
        if (this._shortTerm.length > this._maxShortTerm) {
            this._shortTerm.shift();
        }
    }

    /**
     * Get conversation context
     */
    getContext(limit = 10) {
        return this._shortTerm.slice(-limit);
    }

    /**
     * Clear short-term context
     */
    clearContext() {
        this._shortTerm = [];
    }

    // ============ LONG-TERM MEMORY ============

    /**
     * Store a memory with a key
     */
    remember(key, value) {
        this._longTerm.set(key.toLowerCase(), {
            value,
            created: Date.now(),
            updated: Date.now()
        });
        this._save();
        state.logActivity(`Remembered: "${key}"`, 'success');
    }

    /**
     * Retrieve a memory by key
     */
    recall(key) {
        const memory = this._longTerm.get(key.toLowerCase());
        return memory ? memory.value : null;
    }

    /**
     * Check if a memory exists
     */
    hasMemory(key) {
        return this._longTerm.has(key.toLowerCase());
    }

    /**
     * Update an existing memory
     */
    updateMemory(key, value) {
        if (this._longTerm.has(key.toLowerCase())) {
            const existing = this._longTerm.get(key.toLowerCase());
            this._longTerm.set(key.toLowerCase(), {
                ...existing,
                value,
                updated: Date.now()
            });
            this._save();
            return true;
        }
        return false;
    }

    /**
     * Delete a memory
     */
    forget(key) {
        const deleted = this._longTerm.delete(key.toLowerCase());
        if (deleted) {
            this._save();
            state.logActivity(`Forgot: "${key}"`, 'info');
        }
        return deleted;
    }

    /**
     * Search memories by keyword (scored retrieval — Part 5).
     * Exact key matches and keyword overlap rank highest. When nothing
     * matches literally, a character-bigram similarity fallback catches
     * small spelling variations (e.g. "favourite colour" → "favorite color").
     */
    search(keyword) {
        const lowerKeyword = String(keyword || '').toLowerCase().trim();
        const terms = lowerKeyword.split(/\s+/).filter(Boolean);

        const scored = [];
        for (const [key, data] of this._longTerm.entries()) {
            const keyLower = key.toLowerCase();
            const valueLower = String(data.value).toLowerCase();
            let score = 0;

            if (keyLower === lowerKeyword) score += 100;
            else if (keyLower.includes(lowerKeyword)) score += 60;
            else if (valueLower.includes(lowerKeyword)) score += 40;

            for (const term of terms) {
                if (keyLower.includes(term)) score += 5;
                if (valueLower.includes(term)) score += 3;
            }

            // Spelling-variation fallback (bigram similarity)
            if (score === 0) {
                const sim = Math.max(
                    this._bigramSimilarity(lowerKeyword, keyLower),
                    this._bigramSimilarity(lowerKeyword, valueLower)
                );
                if (sim > 0.45) score += Math.round(sim * 30);
            }

            if (score > 0) scored.push({ key, ...data, score });
        }

        return scored.sort((a, b) => b.score - a.score);
    }

    /**
     * Dice coefficient over character bigrams — a light, dependency-free
     * similarity measure for fuzzy recall.
     */
    _bigramSimilarity(a, b) {
        const as = this._bigrams(a);
        const bs = this._bigrams(b);
        if (!as.size || !bs.size) return 0;
        let overlap = 0;
        for (const g of as) if (bs.has(g)) overlap++;
        return (2 * overlap) / (as.size + bs.size);
    }

    _bigrams(s) {
        const set = new Set();
        const str = s.replace(/[^a-z0-9]/g, '');
        for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
        return set;
    }

    /**
     * Best-effort recall with fuzzy scoring (Part 5). Returns the closest
     * memory (or null) even when the key is not an exact match.
     */
    recallFuzzy(keyword) {
        const results = this.search(keyword);
        return results.length ? results[0] : null;
    }

    // ============ PREFERENCES (Part 5) ============

    setPreference(key, value) {
        this._preferences[key.toLowerCase()] = value;
        this._save();
        state.logActivity(`Preference set: ${key}`, 'info');
    }

    getPreference(key) {
        return this._preferences[key.toLowerCase()] ?? null;
    }

    getAllPreferences() {
        return { ...this._preferences };
    }

    deletePreference(key) {
        const deleted = delete this._preferences[key.toLowerCase()];
        if (deleted) this._save();
        return deleted;
    }

    // ============ PROJECT CONTEXT (Part 5) ============

    setProjectContext(project, key, value) {
        const p = project.toLowerCase();
        if (!this._projectContext[p]) this._projectContext[p] = {};
        this._projectContext[p][key.toLowerCase()] = value;
        this._save();
    }

    getProjectContext(project) {
        return this._projectContext[project.toLowerCase()] || {};
    }

    clearProjectContext(project) {
        delete this._projectContext[project.toLowerCase()];
        this._save();
    }

    // ============ PINNED FACTS (Part 5) ============

    pinFact(text) {
        const fact = { id: Date.now().toString(), text, pinned: Date.now() };
        this._pinnedFacts.unshift(fact);
        this._save();
        return fact;
    }

    unpinFact(id) {
        const idx = this._pinnedFacts.findIndex(f => f.id === id);
        if (idx !== -1) {
            this._pinnedFacts.splice(idx, 1);
            this._save();
            return true;
        }
        return false;
    }

    getPinnedFacts() {
        return [...this._pinnedFacts];
    }

    // ============ TASK HISTORY (Part 5) ============

    recordTask(goal, status, summary = '') {
        const entry = {
            id: Date.now().toString(),
            goal,
            status,
            summary,
            at: Date.now()
        };
        this._taskHistory.unshift(entry);
        if (this._taskHistory.length > 50) this._taskHistory.pop();
        this._save();
        return entry;
    }

    getTaskHistory(limit = 20) {
        return this._taskHistory.slice(0, limit);
    }

    clearTaskHistory() {
        this._taskHistory = [];
        this._save();
    }

    /**
     * Get all memories
     */
    getAllMemories() {
        const memories = [];
        for (const [key, data] of this._longTerm.entries()) {
            memories.push({ key, ...data });
        }
        return memories.sort((a, b) => b.updated - a.updated);
    }

    /**
     * Clear all long-term memory (and Part 5 memory stores)
     */
    clearAllMemory() {
        this._longTerm.clear();
        this._notes = [];
        this._reminders = [];
        this._preferences = {};
        this._projectContext = {};
        this._pinnedFacts = [];
        this._taskHistory = [];
        this._save();
        state.logActivity('All memory cleared', 'warning');
    }

    // ============ NOTES ============

    /**
     * Add a note
     */
    addNote(title, content) {
        const note = {
            id: Date.now().toString(),
            title,
            content,
            created: Date.now(),
            updated: Date.now()
        };
        this._notes.unshift(note);
        this._save();
        state.logActivity(`Note added: "${title}"`, 'success');
        return note;
    }

    /**
     * Get all notes
     */
    getNotes() {
        return this._notes;
    }

    /**
     * Get note by ID
     */
    getNote(id) {
        return this._notes.find(n => n.id === id);
    }

    /**
     * Update a note
     */
    updateNote(id, title, content) {
        const note = this._notes.find(n => n.id === id);
        if (note) {
            note.title = title;
            note.content = content;
            note.updated = Date.now();
            this._save();
            return true;
        }
        return false;
    }

    /**
     * Delete a note
     */
    deleteNote(id) {
        const index = this._notes.findIndex(n => n.id === id);
        if (index !== -1) {
            this._notes.splice(index, 1);
            this._save();
            state.logActivity('Note deleted', 'info');
            return true;
        }
        return false;
    }

    /**
     * Search notes
     */
    searchNotes(keyword) {
        const lowerKeyword = keyword.toLowerCase();
        return this._notes.filter(n => 
            n.title.toLowerCase().includes(lowerKeyword) ||
            n.content.toLowerCase().includes(lowerKeyword)
        );
    }

    // ============ REMINDERS ============

    /**
     * Add a reminder
     */
    addReminder(text, time, type = 'once') {
        const reminder = {
            id: Date.now().toString(),
            text,
            time: new Date(time).getTime(),
            type, // 'once', 'daily', 'weekly'
            completed: false,
            created: Date.now()
        };
        this._reminders.push(reminder);
        this._save();
        state.logActivity(`Reminder set: "${text}" at ${new Date(time).toLocaleString()}`, 'success');
        return reminder;
    }

    /**
     * Get all reminders
     */
    getReminders(includeCompleted = false) {
        const now = Date.now();
        return this._reminders
            .filter(r => includeCompleted || (!r.completed && r.time > now - 86400000))
            .sort((a, b) => a.time - b.time);
    }

    /**
     * Get pending reminders
     */
    getPendingReminders() {
        const now = Date.now();
        return this._reminders
            .filter(r => !r.completed && r.time <= now)
            .sort((a, b) => a.time - b.time);
    }

    /**
     * Complete a reminder
     */
    completeReminder(id) {
        const reminder = this._reminders.find(r => r.id === id);
        if (reminder) {
            if (reminder.type === 'once') {
                reminder.completed = true;
            } else {
                // Reschedule for next occurrence
                const day = 86400000;
                const week = 604800000;
                const increment = reminder.type === 'daily' ? day : week;
                reminder.time += increment;
            }
            this._save();
            return true;
        }
        return false;
    }

    /**
     * Delete a reminder
     */
    deleteReminder(id) {
        const index = this._reminders.findIndex(r => r.id === id);
        if (index !== -1) {
            this._reminders.splice(index, 1);
            this._save();
            return true;
        }
        return false;
    }

    /**
     * Clean up old completed reminders
     */
    _cleanReminders() {
        const dayAgo = Date.now() - 86400000;
        this._reminders = this._reminders.filter(r => 
            !r.completed || r.time > dayAgo
        );
    }

    /**
     * Check for due reminders periodically
     */
    _startReminderChecker() {
        setInterval(() => {
            const pending = this.getPendingReminders();
            if (pending.length > 0) {
                state.logActivity(`Reminder due: "${pending[0].text}"`, 'success');
            }
        }, 30000); // Check every 30 seconds
    }

    /**
     * Get reminders due soon (within next hour)
     */
    getUpcomingReminders() {
        const now = Date.now();
        const hourFromNow = now + 3600000;
        return this._reminders
            .filter(r => !r.completed && r.time > now && r.time <= hourFromNow)
            .sort((a, b) => a.time - b.time);
    }
}

// Singleton instance
export const memory = new MemorySystem();
