/**
 * ALICE Permission System (Part 4)
 * ------------------------------------------------------------------
 * ALICE must NOT have unrestricted autonomy. Before a potentially
 * sensitive or irreversible action, the agent pauses and asks the user
 * for explicit confirmation.
 *
 * The user can approve or cancel from BOTH the UI (confirmation dialog)
 * and voice ("approve" / "cancel").
 *
 * This module:
 *   - classifies an agent step as safe vs. sensitive
 *   - exposes a promise-based confirmation request
 *   - resolves that promise via UI buttons or a recognized voice answer
 */
import { state } from './state.js';
import { CONFIG } from './config.js';

// Words/phrases that mean "approve"
const APPROVE_WORDS = [
    'yes', 'yeah', 'yep', 'approve', 'ok', 'okay', 'okie', 'go ahead',
    'confirm', 'proceed', 'do it', 'sure', 'please do', 'accepted'
];

// Words/phrases that mean "cancel"
const CANCEL_WORDS = [
    'no', 'nope', 'cancel', 'stop', 'abort', 'don\'t', 'dont', 'never mind',
    'hold on', 'wait', 'not now', 'no thanks', 'decline', 'reject'
];

// Destructive / outward-facing / account-level action keywords.
// Any step whose action (or input) matches these is treated as sensitive
// unless explicitly marked otherwise.
const SENSITIVE_ACTION_PATTERNS = [
    /\b(delete|remove|erase|wipe|clear)\b/i,
    /\bforget\b/i,
    /\b(send|email|mail|post|share|publish|tweet|submit|transmit)\b/i,
    /\b(account|password|credential|login|logout|payment|purchase|buy|order)\b/i,
    /\b(format|uninstall|overwrite|replace all|delete all)\b/i,
    /\b(execute|run|install)\s+(?:a\s+)?(?:command|script|code)\b/i
];

class PermissionManager {
    constructor() {
        this._pending = null;   // { resolve, meta }
        this._modal = null;
        this._onPrompt = null;  // called when a confirmation dialog opens
        this._onResolved = null;// called when the confirmation is answered
        this._promptCounter = 0;
    }

    /**
     * Attach the confirmation modal DOM. The module binds Approve/Cancel
     * buttons so the UI path always works, independent of voice.
     */
    attachModal(root) {
        this._modal = root;
        if (!root) return;

        const approveBtn = root.querySelector('[data-confirm="approve"]');
        const cancelBtn = root.querySelector('[data-confirm="cancel"]');

        approveBtn?.addEventListener('click', () => this.answer(true));
        cancelBtn?.addEventListener('click', () => this.answer(false));
    }

    /** Called when a confirmation prompt should be surfaced (voice + UI). */
    onPrompt(cb) { this._onPrompt = cb; }

    /** Called when a confirmation is resolved (either path). */
    onResolved(cb) { this._onResolved = cb; }

    hasPending() {
        return !!this._pending;
    }

    getPendingMeta() {
        return this._pending ? this._pending.meta : null;
    }

    /**
     * Classify a plan step as safe or sensitive.
     * Returns { requiresConfirmation, reason }.
     */
    evaluateStep(step = {}) {
        if (!CONFIG.permissions.enabled) {
            return { requiresConfirmation: false, reason: '' };
        }

        // Planner may have already flagged the step
        if (step.risk === 'sensitive') {
            return { requiresConfirmation: true, reason: step.reason || 'sensitive action' };
        }

        const actionText = `${step.action || ''} ${step.label || ''} ${step.input || ''}`;
        for (const pattern of SENSITIVE_ACTION_PATTERNS) {
            if (pattern.test(actionText)) {
                const reason = this._reasonFor(actionText);
                return { requiresConfirmation: true, reason };
            }
        }

        return { requiresConfirmation: false, reason: '' };
    }

    _reasonFor(text) {
        if (/\b(delete|remove|erase|wipe|clear|forget)\b/i.test(text)) {
            return 'destructive action (cannot be easily undone)';
        }
        if (/\b(send|email|mail|post|share|publish|tweet|submit|transmit)\b/i.test(text)) {
            return 'sends data externally';
        }
        if (/\b(account|password|credential|login|payment|purchase|buy|order)\b/i.test(text)) {
            return 'changes to accounts or payments';
        }
        return 'potentially sensitive action';
    }

    /**
     * Request user confirmation. Resolves `true` on approve, `false` on cancel.
     * Shows the modal and fires `onPrompt` so the voice layer can speak + listen.
     */
    requestConfirmation({ title = 'Confirmation required', message = '', action = '' } = {}) {
        return new Promise((resolve) => {
            // If a previous prompt is somehow still open, resolve it as cancelled.
            if (this._pending) {
                this._resolvePending(false);
            }

            const meta = { title, message, action, id: ++this._promptCounter };
            this._pending = { resolve, meta };

            this._showModal(meta);
            state.logActivity(`Awaiting confirmation: ${action || title}`, 'warning');

            if (this._onPrompt) this._onPrompt(meta);
        });
    }

    /**
     * Answer the pending confirmation from the UI.
     */
    answer(approved) {
        if (!this._pending) return false;
        this._resolvePending(!!approved);
        return true;
    }

    /**
     * Answer the pending confirmation from recognized voice text.
     * Returns `true` if the text was recognized as approve/cancel,
     * `null` if it was not a confirmation answer (caller should re-prompt).
     */
    answerVoice(text) {
        if (!this._pending) return null;
        const t = String(text || '').toLowerCase().trim();

        const isApprove = APPROVE_WORDS.some(w => t === w || t.includes(w));
        const isCancel = CANCEL_WORDS.some(w => t === w || t.includes(w));

        if (isApprove && !isCancel) {
            this._resolvePending(true);
            return true;
        }
        if (isCancel) {
            this._resolvePending(false);
            return false;
        }
        return null;
    }

    _resolvePending(approved) {
        const pending = this._pending;
        this._pending = null;
        this._hideModal();
        pending.resolve(approved);
        state.logActivity(approved ? 'User approved the action' : 'User cancelled the action', approved ? 'success' : 'warning');
        if (this._onResolved) this._onResolved({ approved, meta: pending.meta });
    }

    _showModal(meta) {
        if (!this._modal) return;
        const title = this._modal.querySelector('[data-confirm-title]');
        const message = this._modal.querySelector('[data-confirm-message]');
        const action = this._modal.querySelector('[data-confirm-action]');
        if (title) title.textContent = meta.title;
        if (message) message.textContent = meta.message;
        if (action) action.textContent = meta.action || '';
        this._modal.classList.add('visible');
        this._modal.setAttribute('aria-hidden', 'false');
    }

    _hideModal() {
        if (!this._modal) return;
        this._modal.classList.remove('visible');
        this._modal.setAttribute('aria-hidden', 'true');
    }
}

// Singleton instance
export const permissions = new PermissionManager();
