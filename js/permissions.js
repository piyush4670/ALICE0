/**
 * ALICE Permission System (Part 4)
 * ------------------------------------------------------------------
 * ALICE must NOT have unrestricted autonomy. Before a potentially
 * sensitive or irreversible action, ALICE pauses and asks the user for
 * explicit confirmation.
 *
 * Architecture (centralized enforcement):
 *
 *     User request → Agent/Planner → Permission GATEWAY → ALLOW/DENY/CONFIRM
 *                                    → Skill execution → Result
 *
 * `gate()` — invoked by skillManager.executeByName() immediately before a
 * skill runs — is the ONE authoritative boundary for skill execution. It
 * classifies each request using:
 *   - the skill manifest's declared risk ('safe' | 'medium' | 'sensitive')
 *   - manifest action metadata (sensitiveActions / safeActions patterns)
 *   - generic sensitive-action keyword patterns on the request text
 * and, when required, issues exactly ONE confirmation prompt (modal +
 * voice). Individual skills never prompt on their own, so duplicate
 * dialogs cannot occur, and no caller can lower a classification —
 * caller-supplied context is never trusted for permission decisions.
 *
 * The user can approve or cancel from BOTH the UI (confirmation dialog)
 * and voice ("approve" / "cancel").
 */
import { state } from './state.js';
import { CONFIG } from './config.js';
import { redact } from './utils.js';

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

// Destructive / outward-facing / account-level actions. Any request whose
// text matches one of these is treated as sensitive unless a skill
// manifest says otherwise. Each entry pairs the detection pattern with the
// user-facing reason shown in the confirmation prompt.
const SENSITIVE_ACTIONS = [
    { pattern: /\b(delete|remove|erase|wipe|clear|forget)\b/i, reason: 'destructive action (cannot be easily undone)' },
    { pattern: /\b(send|email|mail|post|share|publish|tweet|submit|transmit)\b/i, reason: 'sends data externally' },
    { pattern: /\b(account|password|credential|login|logout|payment|purchase|buy|order)\b/i, reason: 'changes to accounts or payments' },
    { pattern: /\b(format|uninstall|overwrite|replace all|delete all)\b/i, reason: 'potentially sensitive action' },
    { pattern: /\b(execute|run)\s+(?:a\s+)?(?:command|script|code)\b/i, reason: 'potentially sensitive action' }
];

// How long an approval is remembered for an identical retried action, so a
// retry of an approved step does not re-prompt. This memo is internal to
// the permission layer — callers can never set or clear it.
const APPROVAL_MEMO_MS = 60000;

// Extra scrub for confirmation surfaces: hides values that follow
// secret-like keywords even in prose form ("my password is hunter2"),
// which the generic key=value redact() patterns can miss. Applied before
// redact() so the keyword itself survives to mark the redaction.
const SECRET_TRAILING = /\b(password|passphrase|secret|token|api[_-]?key)\b[^.!?]*$/gi;

function scrubForDisplay(text) {
    return redact(String(text ?? '').replace(SECRET_TRAILING, '$1 [REDACTED]'));
}

class PermissionManager {
    constructor() {
        this._pending = null;   // { resolve, meta }
        this._modal = null;
        this._onPrompt = null;  // called when a confirmation dialog opens
        this._onResolved = null;// called when the confirmation is answered
        this._promptCounter = 0;
        this._approved = new Map(); // approval memo (permission-layer internal)
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

    // ------------------------------------------------------------------
    // Classification
    // ------------------------------------------------------------------

    /**
     * Classify a plan step (planner/test-facing classifier). Note: the
     * authoritative boundary for skill execution is gate() below — steps
     * are ultimately gated inside skillManager.executeByName().
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
        const hit = this._matchSensitive(actionText);
        if (hit) {
            return { requiresConfirmation: true, reason: hit.reason };
        }

        return { requiresConfirmation: false, reason: '' };
    }

    /**
     * Classify a skill execution request for the gateway. Combines the
     * skill manifest metadata with the generic sensitive-action patterns:
     *
     *   risk 'sensitive' → confirm by default, except requests matching a
     *                     declared safeActions pattern (read-only
     *                     exemptions) — deny-by-default for sensitive skills
     *   any skill        → confirm on declared sensitiveActions patterns
     *                     (sub-actions of medium-risk skills that need
     *                     consent) and on the generic patterns
     */
    classifyExecution(skill, text) {
        if (!CONFIG.permissions.enabled) {
            return { requiresConfirmation: false, reason: '' };
        }
        const t = String(text ?? '');

        if (skill && skill.risk === 'sensitive') {
            const safe = this._matchesAnyAction(skill.safeActions, t);
            if (!safe) {
                return { requiresConfirmation: true, reason: 'sensitive skill action' };
            }
        }

        if (skill && Array.isArray(skill.sensitiveActions)) {
            const hit = this._findActionMatch(skill.sensitiveActions, t);
            if (hit) {
                return { requiresConfirmation: true, reason: hit.reason || 'sensitive action' };
            }
        }

        const generic = this._matchSensitive(t);
        if (generic) {
            return { requiresConfirmation: true, reason: generic.reason };
        }
        return { requiresConfirmation: false, reason: '' };
    }

    _matchSensitive(text) {
        for (const entry of SENSITIVE_ACTIONS) {
            if (entry.pattern.test(text)) return entry;
        }
        return null;
    }

    _matchesAnyAction(actions, text) {
        const list = Array.isArray(actions) ? actions : [];
        return list.some(a =>
            a && a.pattern && typeof a.pattern.test === 'function' && a.pattern.test(text));
    }

    _findActionMatch(actions, text) {
        if (!Array.isArray(actions)) return null;
        for (const a of actions) {
            if (a && a.pattern && typeof a.pattern.test === 'function' && a.pattern.test(text)) {
                return a;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // The gateway — the one authoritative permission boundary
    // ------------------------------------------------------------------

    /**
     * Invoked by skillManager.executeByName() immediately before a skill
     * executes. This is the ONLY place a skill-execution confirmation is
     * issued, so an action can never be prompted twice, and every caller
     * (agent, conversation, or direct API use) passes through the same
     * boundary.
     *
     * Caller-supplied context can never lower the classification: only the
     * skill manifest and the request text decide. Additional caller text
     * (a declared action label) can only make classification stricter.
     *
     * Returns:
     *   { allowed: true }
     *   { allowed: false, decision: 'denied'|'unavailable', skill, reason, message }
     */
    async gate(skill, input, context = {}) {
        if (!skill) {
            return {
                allowed: false,
                decision: 'unavailable',
                skill: null,
                reason: 'unknown skill',
                message: 'Skill is not available.'
            };
        }
        if (!CONFIG.permissions.enabled) {
            // Global kill switch (existing CONFIG.permissions semantics)
            return { allowed: true };
        }

        const actionLabel = (context && typeof context.action === 'string') ? context.action : '';
        const text = `${String(input ?? '')} ${actionLabel}`.trim();

        const cls = this.classifyExecution(skill, text);
        if (!cls.requiresConfirmation) {
            return { allowed: true };
        }

        // A retried action the user just approved does not re-prompt
        const key = this._approvalKey(skill, input);
        if (this._isRecentlyApproved(key)) {
            return { allowed: true };
        }

        const approved = await this.requestConfirmation({
            title: 'Confirmation required',
            message: `This is a ${cls.reason}.`,
            action: text.slice(0, 300)
        });

        if (approved) {
            this._rememberApproval(key);
            return { allowed: true };
        }

        return {
            allowed: false,
            decision: 'denied',
            skill: skill.name,
            reason: cls.reason,
            message: 'Cancelled — the action was not approved. Nothing was changed.'
        };
    }

    _approvalKey(skill, input) {
        return `${skill.name}::${String(input ?? '').trim().toLowerCase()}`;
    }

    _isRecentlyApproved(key) {
        const at = this._approved.get(key);
        return typeof at === 'number' && (Date.now() - at) <= APPROVAL_MEMO_MS;
    }

    _rememberApproval(key) {
        // Keep the memo bounded
        if (this._approved.size > 64) {
            const now = Date.now();
            for (const [k, at] of this._approved) {
                if (now - at > APPROVAL_MEMO_MS) this._approved.delete(k);
            }
        }
        this._approved.set(key, Date.now());
    }

    // ------------------------------------------------------------------
    // Confirmation prompt (modal + voice)
    // ------------------------------------------------------------------

    /**
     * Request user confirmation. Resolves `true` on approve, `false` on
     * cancel. Shows the modal and fires `onPrompt` so the voice layer can
     * speak + listen. Everything displayed or spoken is scrubbed of
     * secret-looking values first.
     */
    requestConfirmation({ title = 'Confirmation required', message = '', action = '' } = {}) {
        return new Promise((resolve) => {
            // If a previous prompt is somehow still open, resolve it as cancelled.
            if (this._pending) {
                this._resolvePending(false);
            }

            // Scrub secrets before anything is displayed or spoken
            const meta = {
                title: scrubForDisplay(title),
                message: scrubForDisplay(message),
                action: scrubForDisplay(action),
                id: ++this._promptCounter
            };
            this._pending = { resolve, meta };

            this._showModal(meta);

            // Reflect the wait in the HUD while a task is running
            const task = state.get('task');
            if (task && task.active) {
                state.setTask({ status: 'waiting_confirmation' });
                state.set('aliceState', CONFIG.states.WAITING);
            }

            state.logActivity(`Awaiting confirmation: ${meta.action || meta.title}`, 'warning');

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

        // Resume the running task, if any, now that the user answered
        const task = state.get('task');
        if (task && task.active) {
            state.setTask({ status: 'running' });
            state.set('aliceState', CONFIG.states.EXECUTING);
        }

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
