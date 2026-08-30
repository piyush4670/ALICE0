/**
 * ALICE Proactive Assistance (Part 5)
 * ------------------------------------------------------------------
 * Periodically surfaces useful, low-risk suggestions when enabled:
 *   - due/upcoming reminders
 *   - pending tasks
 *   - follow-up suggestions based on recent memory/task activity
 *
 * Frequency is controlled by settings.proactive.level (off/low/moderate/high).
 * Suggestions are shown as notifications and, at higher levels, logged to the
 * activity feed. They never take actions on their own.
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { memory } from './memory.js';
import { settings } from './settings.js';

class ProactiveAssistant {
    constructor() {
        this._timer = null;
        this._spokenThisSession = 0;
    }

    /**
     * Start the periodic suggestion loop.
     */
    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this.check(), CONFIG.proactive.checkInterval);
        state.logActivity('Proactive assistance ready', 'info');
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    /**
     * Run one suggestion check. Called on a timer; also invocable manually
     * (e.g. after boot) for tests.
     */
    check() {
        if (!settings.proactiveEnabled()) return;
        const level = settings.proactiveLevel();
        if (level === 'off') return;

        const suggestions = this._gather(level);
        for (const text of suggestions) {
            this._emit(text, level);
        }
    }

    _gather(level) {
        const suggestions = [];

        // Reminders due now or within the hour (always relevant)
        const due = memory.getPendingReminders();
        if (due.length > 0) {
            suggestions.push(`You have ${due.length} reminder(s) due now.`);
        }
        const upcoming = memory.getUpcomingReminders();
        if (upcoming.length > 0) {
            suggestions.push(`Reminder coming up: "${upcoming[0].text}".`);
        }

        // Pending tasks (open reminders)
        const open = memory.getReminders().filter(r => !r.completed);
        if (open.length > 0) {
            suggestions.push(`You have ${open.length} open task(s).`);
        }

        // Follow-up: recent failed or completed task in history
        if (level === 'moderate' || level === 'high') {
            const history = memory.getTaskHistory(3);
            const lastFailed = history.find(t => t.status === 'failed');
            if (lastFailed) {
                suggestions.push(`A recent task didn't finish: "${lastFailed.goal}". Would you like to retry it?`);
            }
        }

        if (level === 'high') {
            const prefs = memory.getAllPreferences();
            const keys = Object.keys(prefs);
            if (keys.length > 0) {
                suggestions.push(`I'm keeping ${keys.length} preference(s) in mind to personalize responses.`);
            }
        }

        return suggestions;
    }

    _emit(text, level) {
        // Avoid flooding: cap suggestions per session
        if (this._spokenThisSession >= CONFIG.proactive.maxSuggestionsPerSession) return;

        // De-duplicate: don't repeat the same suggestion back-to-back
        const recent = state.get('proactive').suggested;
        if (recent.some(s => s.text === text && Date.now() - s.at < CONFIG.proactive.checkInterval * 2)) {
            return;
        }

        state.recordSuggestion(text);
        this._spokenThisSession++;

        state.notify(text, 'info', { duration: 8000 });
        if (level === 'high') {
            state.logActivity(`Suggestion: ${text}`, 'info');
        }
    }
}

// Singleton instance
export const proactive = new ProactiveAssistant();
