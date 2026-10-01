/**
 * Memory Skill
 * Handles user-controlled long-term memory
 *
 * Part 10.3 — safe forgetting:
 * A forget/delete request is resolved to ONE memory before anything is
 * deleted. An ambiguous search never deletes anything (it asks the user to
 * choose), approvals are bound to the `forget` operation *and* the resolved
 * memory key, and the memory is re-fetched and compared against the snapshot
 * the user confirmed before it is deleted. The approval flow mirrors
 * js/skills/notes.js: the permission gateway (skillManager.executeByName)
 * issues the single confirmation prompt, and the skill only prompts on its
 * own when it is executed directly without a gateway approval.
 */
import { state } from '../state.js';
import { memory } from '../memory.js';
import { permissions } from '../permissions.js';
import { CONFIG } from '../config.js';
import { redact } from '../utils.js';

/** Maximum length of the value preview shown when asking the user to choose. */
const VALUE_PREVIEW_LENGTH = 60;

export const memorySkill = {
    name: 'memory',
    description: 'Manages user-controlled long-term memory',
    patterns: [
        /remember\s+that/i,
        /remember\s+(?:my\s+)?/i,
        /save\s+(?:that|this)/i,
        /i\s+(?:have|own|use)\s+(?:a\s+)?/i,
        /my\s+(?:name|project|dog|cat|car|phone)/i,
        /what(?:\'s| is) (?:my|i)\s+/i,
        /do\s+you\s+remember/i,
        /forget\s+(?:that|this|my)/i,
        /delete\s+(?:that|this|my)/i,
        /what\s+do\s+i\s+(?:have|know|remember)/i,
        /recall\s+(?:that|my)/i,
        /tell\s+me\s+(?:my|about\s+my)/i
    ],

    // Snapshot of the memory shown to the user when confirmation was issued.
    // Set by getApprovalKey() (gateway path) and by _forget() (direct path);
    // cleared whenever a deletion attempt is resolved.
    _snapshot: null,

    /**
     * Execute memory command
     */
    async execute(input, context = {}) {
        const text = String(input ?? '').toLowerCase();

        // Retrieval commands
        if (text.match(/what(?:\'s| is) (?:my|i)\s+/) || 
            text.match(/do\s+you\s+remember/i) ||
            text.match(/what\s+do\s+i\s+(?:have|know|remember)/i) ||
            text.match(/recall|tell\s+me\s+about/i)) {
            return this._recall(input);
        }

        // Forget/delete commands
        if (this._isForgetRequest(input, context)) {
            return this._forget(input, context);
        }

        // Store commands
        if (text.match(/remember|save\s+(?:that|this)/i) ||
            text.match(/i\s+(?:have|own|use)\s+(?:a\s+)?/i)) {
            return this._remember(input);
        }

        return {
            success: false,
            error: 'I\'m not sure what you want me to do with memory'
        };
    },

    /**
     * True when the request asks to forget/delete a memory. Shared by
     * execute() and getApprovalKey() so routing and approval binding can
     * never disagree about which command is being handled.
     */
    _isForgetRequest(input, context = {}) {
        const text = String(input ?? '').toLowerCase();
        if (text.match(/forget|delete\s+(?:that|this|my)/i)) return true;
        return !!(context && context.action === 'delete');
    },

    /**
     * Store a memory
     */
    _remember(input) {
        // Pattern: "Remember that my [key] is [value]"
        // Pattern: "My [key] is [value]"
        // Pattern: "I have a [key] called [value]"
        
        let key, value;
        
        // Extract key-value pairs
        const patterns = [
            /remember\s+(?:that\s+)?(?:my\s+)?(.+?)\s+is\s+(.+)/i,
            /my\s+(.+?)\s+is\s+(.+)/i,
            /remember\s+(?:that\s+)?i\s+(?:have\s+(?:a\s+)?|own\s+(?:a\s+)?)(.+)/i,
            /save\s+(?:that\s+)?(?:my\s+)?(.+?)\s+(?:as|called|named)\s+(.+)/i
        ];
        
        for (const pattern of patterns) {
            const match = input.match(pattern);
            if (match) {
                if (match[2]) {
                    key = match[1].trim();
                    value = match[2].trim();
                } else {
                    value = match[1].trim();
                    key = this._extractKey(value);
                }
                break;
            }
        }
        
        if (!key || !value) {
            return {
                success: false,
                error: 'What would you like me to remember? Try saying "Remember that my [something] is [value]".'
            };
        }
        
        memory.remember(key, value);
        
        return {
            success: true,
            result: `Okay, I'll remember that your ${key} is ${value}.`
        };
    },

    /**
     * Recall a memory
     */
    _recall(input) {
        // Extract what to recall
        let searchTerm = input
            .replace(/what(?:\'s| is) (?:my|i)\s+/i, '')
            .replace(/do\s+you\s+remember\s+(?:my\s+)?/i, '')
            .replace(/what\s+do\s+i\s+(?:have|know|remember)\s+/i, '')
            .replace(/recall|tell\s+me\s+(?:about\s+)?my\s+/i, '')
            .replace(/\?/g, '')
            .trim();
        
        if (!searchTerm || searchTerm === 'i' || searchTerm === 'me') {
            // List all memories
            const all = memory.getAllMemories();
            if (all.length === 0) {
                return {
                    success: true,
                    result: 'You haven\'t told me anything to remember yet. Just say "Remember that my [something] is [value]" to save information.'
                };
            }
            
            const list = all.slice(0, 5).map((m, i) => `${i + 1}. ${m.key}: ${m.value}`).join('\n');
            return {
                success: true,
                result: `Here's what I remember about you:\n${list}`
            };
        }
        
        // Search for specific memory
        const value = memory.recall(searchTerm);
        
        if (value !== null) {
            return {
                success: true,
                result: `Your ${searchTerm} is ${value}.`
            };
        }
        
        // Try fuzzy search
        const results = memory.search(searchTerm);
        if (results.length > 0) {
            const closest = results[0];
            return {
                success: true,
                result: `Based on what you told me, your ${closest.key} is ${closest.value}.`
            };
        }
        
        return {
            success: false,
            error: `I don't have anything saved about "${searchTerm}". Would you like me to remember it?`
        };
    },

    /**
     * Resolve which memory a forget/delete request refers to.
     *
     * Returns exactly one of:
     *   { type: 'invalid' }                     — input is not text
     *   { type: 'empty' }                       — nothing was named
     *   { type: 'exact', keyword, entry }       — an exact memory key was named
     *   { type: 'single', keyword, entry }      — exactly one search hit
     *   { type: 'multiple', keyword, matches }  — ambiguous, never deletable
     *   { type: 'none', keyword }               — nothing saved matches
     *
     * `entry` is always the stored memory record ({ key, value, created,
     * updated }) — the first result of an ambiguous search is never used as
     * a deletion target.
     */
    _parseForgetTarget(input) {
        if (typeof input !== 'string') {
            return { type: 'invalid' };
        }

        // Extract what to forget
        const keyword = input
            .replace(/forget\b(?:\s+(?:that|this|my))?\s*/i, '')
            .replace(/delete\b(?:\s+(?:that|this|my))?\s*/i, '')
            .replace(/\?/g, '')
            .replace(/[.!,;:]+$/, '')
            .trim();

        if (!keyword) {
            return { type: 'empty' };
        }

        // Exact key match — the user named the memory itself.
        const exact = memory.getMemory(keyword);
        if (exact) {
            return { type: 'exact', keyword, entry: exact };
        }

        // Partial search — only a single, unambiguous hit is deletable.
        const results = memory.search(keyword).filter(m => m && typeof m.key === 'string');
        if (results.length === 0) {
            return { type: 'none', keyword };
        }
        if (results.length > 1) {
            return { type: 'multiple', keyword, matches: results };
        }

        return { type: 'single', keyword, entry: results[0] };
    },

    /**
     * Snapshot of a memory: the key plus the value and timestamps needed to
     * prove, after confirmation, that the target is still the same memory.
     */
    _snapshotOf(entry) {
        if (!entry) return null;
        return {
            key: String(entry.key).toLowerCase(),
            value: entry.value,
            created: entry.created,
            updated: entry.updated
        };
    },

    /**
     * The snapshot getApprovalKey() captured for THIS request — the gateway
     * calls it immediately before opening the confirmation prompt. A snapshot
     * left over from an earlier, already-resolved request is ignored, so a
     * stale snapshot can never block or mislabel a later request.
     */
    _confirmedSnapshot(input) {
        const snapshot = this._snapshot;
        if (!snapshot) return null;
        if (snapshot.input !== String(input ?? '').trim().toLowerCase()) return null;
        return snapshot;
    },

    /**
     * True when a freshly fetched memory is still the one that was shown to
     * the user (same key and unchanged value / timestamps).
     */
    _matchesSnapshot(entry, snapshot) {
        if (!entry || !snapshot) return false;
        return String(entry.key).toLowerCase() === snapshot.key &&
            entry.value === snapshot.value &&
            entry.created === snapshot.created &&
            entry.updated === snapshot.updated;
    },

    /**
     * Short, redacted value preview used only to tell matching memories apart.
     */
    _preview(value) {
        const text = String(value ?? '');
        const clipped = text.length > VALUE_PREVIEW_LENGTH
            ? `${text.substring(0, VALUE_PREVIEW_LENGTH)}...`
            : text;
        return redact(clipped);
    },

    /**
     * Bind the approval to the forget operation and the resolved memory key
     * (never to the raw sentence alone), and record the snapshot of the
     * memory the user is being asked about.
     *
     * Returns null for an empty, missing, or ambiguous target: such a request
     * is not a confirmed deletion target, so the gateway falls back to the
     * raw request text and no target-bound approval is created.
     */
    getApprovalKey(input, context = {}) {
        if (!this._isForgetRequest(input, context)) return null;

        const target = this._parseForgetTarget(input);
        if (target.type === 'exact' || target.type === 'single') {
            this._snapshot = {
                ...this._snapshotOf(target.entry),
                input: String(input ?? '').trim().toLowerCase()
            };
            return `forget::${String(target.entry.key).toLowerCase()}`;
        }

        this._snapshot = null;
        return null;
    },

    /**
     * Forget a memory — safely.
     *
     * Nothing is deleted unless the request resolves to exactly one memory
     * that still matches the snapshot captured before confirmation.
     */
    async _forget(input, context = {}) {
        const target = this._parseForgetTarget(input);
        const confirmed = this._confirmedSnapshot(input);

        if (target.type === 'invalid' || target.type === 'empty') {
            this._snapshot = null;
            return {
                success: false,
                error: 'What would you like me to forget? Please specify what to delete.'
            };
        }

        if (target.type === 'none') {
            // The memory the user was just asked about can vanish before the
            // confirmation is answered — say so instead of a generic miss.
            const vanished = (confirmed && confirmed.key === String(target.keyword).toLowerCase())
                ? confirmed.key
                : null;
            this._snapshot = null;
            if (vanished) {
                permissions.consumeApproval(`memory::forget::${vanished}`);
                permissions.consumeApproval(this._legacyApprovalKey(input));
                return {
                    success: false,
                    error: `The memory "${vanished}" disappeared while confirmation was pending, so I didn't delete anything. Please review the request again.`
                };
            }
            return {
                success: false,
                error: `I don't have anything saved about "${target.keyword}" to forget.`
            };
        }

        if (target.type === 'multiple') {
            const formatted = target.matches
                .map(m => `- "${m.key}" (saved value: "${this._preview(m.value)}")`)
                .join('\n');
            const clarifyMsg = `I found ${target.matches.length} memories matching "${target.keyword}" and didn't delete anything. ` +
                `Please say which one to forget using its exact key:\n${formatted}`;

            this._snapshot = null;
            return {
                success: false,
                error: clarifyMsg,
                clarification: clarifyMsg,
                matches: target.matches.map(m => ({
                    key: m.key,
                    value: m.value,
                    created: m.created,
                    updated: m.updated
                }))
            };
        }

        // Unambiguous target: either an exact key or a single search hit.
        const entry = target.entry;
        const key = String(entry.key).toLowerCase();
        const approvalKey = `memory::forget::${key}`;

        // Never fall back to another memory: if the request no longer resolves
        // to the memory the user confirmed, nothing is deleted.
        if (confirmed && confirmed.key !== key) {
            this._snapshot = null;
            permissions.consumeApproval(`memory::forget::${confirmed.key}`);
            permissions.consumeApproval(approvalKey);
            permissions.consumeApproval(this._legacyApprovalKey(input));
            return {
                success: false,
                error: `This request no longer matches the memory you confirmed (${confirmed.key}), so I didn't delete anything. Please review the request again.`
            };
        }

        // Snapshot presented to the user: the one taken by getApprovalKey()
        // when the gateway opened the confirmation, otherwise the memory as
        // it stands right now (direct execution).
        let snapshot = confirmed;

        // The memory must still exist before anything is confirmed or deleted.
        const current = memory.getMemory(key);
        if (!current) {
            this._snapshot = null;
            permissions.consumeApproval(approvalKey);
            permissions.consumeApproval(this._legacyApprovalKey(input));
            return {
                success: false,
                error: confirmed
                    ? `The memory "${key}" disappeared while confirmation was pending, so I didn't delete anything. Please review the request again.`
                    : `I couldn't find a memory called "${key}" to delete.`
            };
        }

        if (!snapshot) snapshot = this._snapshotOf(current);

        // Confirmation. The gateway (skillManager.executeByName) already
        // asked the user and memoized a target-bound approval; only a direct
        // call that bypassed the gateway prompts here, so the user is never
        // asked twice for the same request.
        if (CONFIG?.permissions?.enabled) {
            if (!permissions.isApproved(approvalKey)) {
                const prePrompt = memory.getMemory(key);
                if (!prePrompt) {
                    this._snapshot = null;
                    return {
                        success: false,
                        error: `I couldn't find a memory called "${key}" to delete.`
                    };
                }
                snapshot = this._snapshotOf(prePrompt);

                const approved = await permissions.requestConfirmation({
                    title: 'Confirmation required',
                    message: 'destructive action (cannot be easily undone)',
                    action: String(input ?? '').slice(0, 300)
                });
                if (!approved) {
                    this._snapshot = null;
                    return {
                        success: false,
                        cancelled: true,
                        error: 'Cancelled — the action was not approved. Nothing was changed.'
                    };
                }
            }
        }

        // After approval, re-fetch the memory and verify it is still the one
        // the user confirmed. A different, changed, or missing memory is
        // never deleted with an approval issued for an earlier target.
        const postApproval = memory.getMemory(key);
        if (!postApproval) {
            this._snapshot = null;
            permissions.consumeApproval(approvalKey);
            permissions.consumeApproval(this._legacyApprovalKey(input));
            return {
                success: false,
                error: `The memory "${key}" disappeared while confirmation was pending, so I didn't delete anything. Please review the request again.`
            };
        }

        if (!this._matchesSnapshot(postApproval, snapshot)) {
            this._snapshot = null;
            // Never delete a changed memory using an approval for its earlier state.
            permissions.consumeApproval(approvalKey);
            permissions.consumeApproval(this._legacyApprovalKey(input));
            return {
                success: false,
                error: `The memory "${key}" changed while confirmation was pending, so I didn't delete anything. Please review the request again.`
            };
        }

        this._snapshot = null;

        const deleted = memory.forget(key);
        if (!deleted) {
            return {
                success: false,
                error: `Failed to forget "${key}".`
            };
        }

        // Consume the approval so it cannot delete another memory later.
        permissions.consumeApproval(approvalKey);
        permissions.consumeApproval(this._legacyApprovalKey(input));

        return {
            success: true,
            result: target.type === 'exact'
                ? `I've forgotten your ${key}.`
                : `I've forgotten that your ${key} was ${postApproval.value}.`
        };
    },

    /**
     * The sentence-based approval key the gateway uses when no target-bound
     * key could be produced (unresolved / ambiguous targets).
     */
    _legacyApprovalKey(input) {
        return `memory::${String(input ?? '').trim().toLowerCase()}`;
    },

    /**
     * Extract a key from value
     */
    _extractKey(value) {
        // Take first significant words
        const words = value.split(' ').slice(0, 3);
        return words.join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '');
    }
};
