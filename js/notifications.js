/**
 * ALICE Notifications (Part 5)
 * ------------------------------------------------------------------
 * Toast-style notifications rendered in the HUD. Used for confirmations,
 * errors, proactive suggestions, and general status. Replaces ad-hoc
 * activity-only feedback with a visible, dismissible surface.
 */
import { state } from './state.js';
import { escapeHtml } from './utils.js';

class NotificationCenter {
    constructor() {
        this._container = null;
        this._timers = new Map();
    }

    init(container) {
        if (!container) return;
        this._container = container;

        state.subscribe('notifications', (list) => this._render(list));
        this._render(state.getNotifications());
    }

    /**
     * Push a notification (also available from anywhere via state.notify).
     */
    notify(message, type = 'info', opts = {}) {
        return state.notify(message, type, opts);
    }

    _render(list) {
        if (!this._container) return;

        this._container.innerHTML = list.map(n => `
            <div class="alice-notification ${n.type}" data-notify-id="${n.id}">
                <span class="alice-notification-icon">${this._icon(n.type)}</span>
                <span class="alice-notification-text">${escapeHtml(n.message)}</span>
                <button class="alice-notification-close" data-notify-dismiss="${n.id}" aria-label="Dismiss">×</button>
            </div>
        `).join('');

        // Dismiss buttons
        this._container.querySelectorAll('[data-notify-dismiss]').forEach(btn => {
            btn.addEventListener('click', () => {
                state.dismissNotification(btn.dataset.notifyDismiss);
            });
        });

        // Auto-dismiss timers
        const live = new Set(list.map(n => String(n.id)));
        for (const [id, timer] of this._timers) {
            if (!live.has(id)) {
                clearTimeout(timer);
                this._timers.delete(id);
            }
        }
        for (const n of list) {
            if (!this._timers.has(String(n.id)) && n.type !== 'danger') {
                const timer = setTimeout(() => {
                    state.dismissNotification(n.id);
                    this._timers.delete(String(n.id));
                }, n.duration || 5000);
                this._timers.set(String(n.id), timer);
            }
        }
    }

    _icon(type) {
        return {
            info: 'ℹ',
            success: '✓',
            warning: '⚠',
            danger: '✕'
        }[type] || 'ℹ';
    }
}

// Singleton instance
export const notifications = new NotificationCenter();
