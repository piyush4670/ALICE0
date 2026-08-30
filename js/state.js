/**
 * ALICE Application State
 * Central state management for the interface
 */
import { CONFIG } from './config.js';

class StateManager {
    constructor() {
        this._state = {
            currentScreen: 'auth', // 'auth' | 'boot' | 'hud'
            aliceState: CONFIG.states.IDLE,
            isAuthenticated: false,
            isBooting: false,
            isProcessing: false,
            currentTime: new Date(),
            bootProgress: 0,
            bootItems: [],
            activityLog: [],
            systemMetrics: {
                cpu: 0,
                memory: 0,
                network: 0
            },
            settings: {
                soundEnabled: true,
                animationsEnabled: true,
                voiceFeedback: true
            }
        };
        
        this._listeners = new Map();
    }

    get(key) {
        return this._state[key];
    }

    set(key, value) {
        const oldValue = this._state[key];
        this._state[key] = value;
        this._notify(key, value, oldValue);
    }

    update(updates) {
        Object.entries(updates).forEach(([key, value]) => {
            this.set(key, value);
        });
    }

    subscribe(key, callback) {
        if (!this._listeners.has(key)) {
            this._listeners.set(key, new Set());
        }
        this._listeners.get(key).add(callback);
        
        // Return unsubscribe function
        return () => {
            this._listeners.get(key).delete(callback);
        };
    }

    _notify(key, newValue, oldValue) {
        if (this._listeners.has(key)) {
            this._listeners.get(key).forEach(callback => {
                callback(newValue, oldValue);
            });
        }
    }

    // Activity logging
    logActivity(message, type = 'info') {
        const entry = {
            timestamp: new Date(),
            message,
            type
        };
        this._state.activityLog.unshift(entry);
        // Keep only last 50 entries
        if (this._state.activityLog.length > 50) {
            this._state.activityLog.pop();
        }
        this._notify('activityLog', this._state.activityLog);
    }

    // Update time
    startTimeUpdates() {
        setInterval(() => {
            this._state.currentTime = new Date();
            this._notify('currentTime', this._state.currentTime);
        }, 1000);
    }

    // Simulate system metrics (placeholder for real metrics)
    startMetricsSimulation() {
        setInterval(() => {
            this._state.systemMetrics = {
                cpu: 15 + Math.random() * 30,
                memory: 40 + Math.random() * 20,
                network: Math.random() * 100
            };
            this._notify('systemMetrics', this._state.systemMetrics);
        }, 2000);
    }
}

// Singleton instance
export const state = new StateManager();
