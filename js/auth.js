/**
 * ALICE Authentication Module
 * Secure authentication handling
 * Note: This is a prototype - replace with proper auth in production
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { delay, animateElement } from './utils.js';

class AuthManager {
    constructor() {
        this._attempts = 0;
        this._locked = false;
        this._lockTimer = null;
        this._storedPin = this._getStoredPin();
    }

    _getStoredPin() {
        // In production, this would verify against a server
        // For prototype, we use a simple hash comparison
        // Default PIN: 1234
        return 'AQADAg=='; // Hashed '1234' - placeholder
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
        return CONFIG.auth.maxAttempts - this._attempts;
    }

    async authenticate(pin, authScreen) {
        if (this._locked) {
            return { success: false, message: 'System locked. Please wait.' };
        }

        // Show loading state
        const statusEl = authScreen.querySelector('.auth-status');
        const inputEl = authScreen.querySelector('.auth-input');
        
        if (statusEl) {
            statusEl.textContent = 'Verifying credentials...';
            statusEl.classList.add('active');
        }

        // Simulate verification delay
        await delay(800);

        // Check PIN - for prototype, accept '1234' or any 4+ digit
        const isValid = pin === CONFIG.auth.defaultPin || pin.length >= 4;

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
            if (inputEl) {
                inputEl.classList.add('shake');
                setTimeout(() => inputEl.classList.remove('shake'), 500);
            }
            
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
    }

    _lockout() {
        this._locked = true;
        
        const lockTimer = setTimeout(() => {
            this._locked = false;
            this._attempts = 0;
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
