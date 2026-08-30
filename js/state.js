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
            },
            // Voice-related state (Part 2)
            voice: {
                isActive: false,
                isListening: false,
                isWakeWordEnabled: true,
                isMicrophoneAvailable: false,
                isMicrophonePermission: false,
                currentTranscript: '',
                lastAliceResponse: ''
            },
            conversation: []
        };
        
        this._listeners = new Map();
    }

    get(key) {
        if (key.includes('.')) {
            const parts = key.split('.');
            let value = this._state;
            for (const part of parts) {
                value = value?.[part];
            }
            return value;
        }
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

    // Deep update for nested objects
    updateDeep(path, updates) {
        const keys = path.split('.');
        let obj = this._state;
        
        for (let i = 0; i < keys.length - 1; i++) {
            obj = obj[keys[i]];
        }
        
        const oldValue = obj[keys[keys.length - 1]];
        obj[keys[keys.length - 1]] = { ...obj[keys[keys.length - 1]], ...updates };
        
        this._notify(path, obj[keys[keys.length - 1]], oldValue);
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
            // Adjust metrics based on current state
            const aliceState = this._state.aliceState;
            let baseCpu = 15;
            
            if (aliceState === CONFIG.states.PROCESSING) baseCpu = 40;
            else if (aliceState === CONFIG.states.SPEAKING) baseCpu = 25;
            else if (aliceState === CONFIG.states.LISTENING) baseCpu = 30;
            
            this._state.systemMetrics = {
                cpu: baseCpu + Math.random() * 20,
                memory: 45 + Math.random() * 15,
                network: 10 + Math.random() * 30
            };
            this._notify('systemMetrics', this._state.systemMetrics);
        }, 2000);
    }

    // Voice state methods
    setVoiceState(key, value) {
        this._state.voice[key] = value;
        this._notify('voice', this._state.voice);
    }

    getVoiceState() {
        return { ...this._state.voice };
    }

    // Transcript updates
    setTranscript(text) {
        this._state.voice.currentTranscript = text;
        this._notify('voice.currentTranscript', text);
    }

    clearTranscript() {
        this._state.voice.currentTranscript = '';
        this._notify('voice.currentTranscript', '');
    }

    setLastResponse(text) {
        this._state.voice.lastAliceResponse = text;
        this._notify('voice.lastAliceResponse', text);
    }

    // Conversation management
    addToConversation(role, text) {
        this._state.conversation.push({
            role,
            text,
            timestamp: new Date()
        });
        
        if (this._state.conversation.length > 20) {
            this._state.conversation.shift();
        }
        
        this._notify('conversation', this._state.conversation);
    }

    clearConversation() {
        this._state.conversation = [];
        this._notify('conversation', []);
    }

    getConversation() {
        return [...this._state.conversation];
    }
}

// Singleton instance
export const state = new StateManager();
