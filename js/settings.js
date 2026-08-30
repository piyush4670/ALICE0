/**
 * ALICE Settings Manager (Part 5)
 * ------------------------------------------------------------------
 * Persists user preferences (proactive level, feature toggles, per-skill
 * enable/disable) to localStorage and keeps `state.settings` in sync.
 *
 * Settings are applied back to the relevant subsystems so toggles actually
 * take effect: skillManager.setEnabled for skills, proactive.level for
 * assistance frequency, and feature flags gate the optional Part 5 skills.
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { skillManager } from './skillManager.js';

class SettingsManager {
    constructor() {
        this._loaded = false;
    }

    /**
     * Load settings from storage and apply them to subsystems.
     */
    init() {
        if (this._loaded) return;
        this._loaded = true;

        const stored = this._readStorage();
        const defaults = CONFIG.settings.defaults;
        const settings = {
            proactive: { ...defaults.proactive, ...(stored.proactive || {}) },
            features: { ...defaults.features, ...(stored.features || {}) },
            skills: { ...(stored.skills || {}) }
        };

        state.setSettings(settings);
        this._apply();
    }

    _readStorage() {
        try {
            const raw = localStorage.getItem(CONFIG.settings.storageKey);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    _persist() {
        try {
            localStorage.setItem(CONFIG.settings.storageKey, JSON.stringify(state.getSettings()));
        } catch (e) {
            console.warn('Failed to persist settings', e);
        }
    }

    /**
     * Apply current settings to subsystems.
     */
    _apply() {
        const s = state.getSettings();

        // Per-skill enable/disable
        for (const name of Object.keys(s.skills)) {
            skillManager.setEnabled(name, !!s.skills[name]);
        }
    }

    /**
     * Public: update one setting and persist + apply.
     */
    set(group, key, value) {
        state.updateSetting(group, key, value);
        this._persist();
        this._apply();

        // Feature toggles log clearly so the user sees the effect
        if (group === 'features') {
            state.logActivity(`${key} ${value ? 'enabled' : 'disabled'}`, value ? 'info' : 'warning');
        }
    }

    /**
     * Toggle a skill on/off.
     */
    setSkillEnabled(name, enabled) {
        state.updateSetting('skills', name, !!enabled);
        skillManager.setEnabled(name, !!enabled);
        this._persist();
    }

    /**
     * Convenience getters
     */
    isFeatureEnabled(feature) {
        return state.getSettings().features[feature] !== false;
    }

    proactiveEnabled() {
        return state.getSettings().proactive.enabled !== false;
    }

    proactiveLevel() {
        return state.getSettings().proactive.level || 'moderate';
    }

    resetAll() {
        localStorage.removeItem(CONFIG.settings.storageKey);
        this._loaded = false;
        this.init();
        state.logActivity('Settings reset to defaults', 'info');
    }
}

// Singleton instance
export const settings = new SettingsManager();
