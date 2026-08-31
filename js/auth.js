/**
 * ALICE Authentication Module
 * Secure authentication handling
 * Note: This is a prototype - replace with proper auth in production
 * (see SECURITY.md: client-side auth is a UX gate, not a security boundary)
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { delay } from './utils.js';

// A well-formed PIN candidate: 4–8 digits (matches the auth input's
// maxlength and numeric pattern in index.html)
const PIN_PATTERN = /^\d{4,8}$/;

class AuthManager {
    constructor() {
        this._attempts = 0;
        this._locked = false;
        this._lockTimer = null;
        this._verifying = false;
        // Only a digest of the configured PIN is kept on this instance.
        // The PIN itself is never stored, never compared in plaintext,
        // and never logged.
        this._storedPin = this._getStoredPin();
    }

    /**
     * In production, this would verify against a server.
     * For the prototype we compare against a digest of the configured PIN,
     * computed with the repository's existing prototype hash.
     */
    _getStoredPin() {
        return this._hashPin(CONFIG.auth.defaultPin);
    }

    _hashPin(pin) {
        // Simple hash for prototype - use bcrypt/scrypt in production
        let hash = 0;
        for (let i = 0; i < pin.length; i++) {
            const char = pin.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return btoa(hash.toString());
    }

    isLocked() {
        return this._locked;
    }

    getAttemptsRemaining() {
        return Math.max(0, CONFIG.auth.maxAttempts - this._attempts);
    }

    /**
     * Shape check for a PIN candidate. Malformed input can never be a
     * valid credential, so it is rejected without counting as an attempt —
     * the max-attempt/lockout budget is reserved for plausible guesses.
     */
    _validatePinFormat(pin) {
        if (typeof pin !== 'string') {
            return { valid: false, error: 'Invalid PIN format.' };
        }
        if (pin.length === 0) {
            return { valid: false, error: 'Please enter your PIN.' };
        }
        if (!/^\d+$/.test(pin)) {
            return { valid: false, error: 'PIN must contain digits only.' };
        }
        if (!PIN_PATTERN.test(pin)) {
            return {
                valid: false,
                error: pin.length < 4
                    ? 'PIN must be at least 4 digits.'
                    : 'PIN must be at most 8 digits.'
            };
        }
        return { valid: true, error: null };
    }

    async authenticate(pin, authScreen) {
        // Ignore re-submissions while a verification is already in flight
        // (prevents duplicate boot sequences from double clicks / Enter)
        if (this._verifying) {
            return { success: false, message: 'Verification already in progress.' };
        }

        if (this._locked) {
            return { success: false, message: 'System locked. Please wait.' };
        }

        // Reject empty, malformed, or unexpected input before any
        // credential check is made
        const format = this._validatePinFormat(pin);
        if (!format.valid) {
            this._showRejection(authScreen, format.error);
            state.logActivity('Rejected malformed PIN input', 'warning');
            return { success: false, message: format.error };
        }

        // Show loading state
        const statusEl = authScreen?.querySelector('.auth-status');
        const inputEl = authScreen?.querySelector('.auth-input');

        if (statusEl) {
            statusEl.textContent = 'Verifying credentials...';
            statusEl.classList.add('active');
        }

        // Simulate verification delay
        this._verifying = true;
        try {
            await delay(800);

            // Verify by digest comparison. The entered PIN is never stored,
            // never compared in plaintext, and never logged. A PIN is never
            // accepted merely because its length is valid.
            const isValid = this._hashPin(pin) === this._storedPin;

            if (isValid) {
                // Success animation
                if (statusEl) {
                    statusEl.textContent = 'Access granted';
                    statusEl.classList.remove('active');
                    statusEl.classList.add('success');
                }

                await delay(500);

                state.set('isAuthenticated', true);
                state.logActivity('User authenticated successfully', 'success');

                return { success: true };
            } else {
                this._attempts++;

                if (statusEl) {
                    statusEl.textContent = `Access denied. ${this.getAttemptsRemaining()} attempts remaining.`;
                    statusEl.classList.add('error');
                }

                // Shake animation
                this._shakeInput(inputEl);

                // Clear input
                if (inputEl) {
                    inputEl.value = '';
                    inputEl.focus();
                }

                state.logActivity(`Failed authentication attempt (${this._attempts}/${CONFIG.auth.maxAttempts})`, 'warning');

                // Check for lockout
                if (this._attempts >= CONFIG.auth.maxAttempts) {
                    this._lockout();
                    return { success: false, message: 'Too many attempts. System locked.' };
                }

                return { success: false, message: 'Invalid PIN' };
            }
        } finally {
            this._verifying = false;
        }
    }

    /**
     * Surface a rejection (malformed input) on the auth screen without
     * consuming an attempt.
     */
    _showRejection(authScreen, message) {
        const statusEl = authScreen?.querySelector('.auth-status');
        const inputEl = authScreen?.querySelector('.auth-input');

        if (statusEl) {
            statusEl.textContent = message;
            statusEl.classList.add('error');
        }

        this._shakeInput(inputEl);

        if (inputEl) {
            inputEl.value = '';
            inputEl.focus();
        }
    }

    _shakeInput(inputEl) {
        if (!inputEl) return;
        inputEl.classList.add('shake');
        setTimeout(() => inputEl.classList.remove('shake'), 500);
    }

    _lockout() {
        this._locked = true;

        // Own the lock timer so it is tracked and cannot stack
        if (this._lockTimer) clearTimeout(this._lockTimer);
        this._lockTimer = setTimeout(() => {
            this._locked = false;
            this._attempts = 0;
            this._lockTimer = null;
            state.logActivity('System unlocked after timeout', 'info');
        }, CONFIG.auth.lockoutDuration);

        state.logActivity('System locked due to too many failed attempts', 'danger');
    }

    logout() {
        this._attempts = 0;
        state.set('isAuthenticated', false);
        state.set('currentScreen', 'auth');
        state.logActivity('User logged out', 'info');
    }
}

// Singleton instance
export const auth = new AuthManager();
