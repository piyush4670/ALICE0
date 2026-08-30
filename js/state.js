/**
 * ALICE Application State
 * Central state management for the interface
 */
import { CONFIG } from './config.js';
import { redact } from './utils.js';

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
            // Skill-related state (Part 3)
            skill: {
                currentSkill: null,
                lastSkill: null,
                executionHistory: [],
                pendingConfirmation: null
            },
            // Task/Agent state (Part 4)
            task: {
                active: false,
                goal: '',
                status: 'idle', // idle | planning | running | waiting_confirmation | completed | failed | cancelled
                plan: [],       // [{ id, label, skill, action, risk, status, result }]
                currentStepIndex: -1,
                currentAction: '',
                progress: 0,
                result: null,
                error: null,
                updatedAt: null
            },
            conversation: [],
            lastReadDocument: null,
            // Part 5
            notifications: [],
            settings: {
                proactive: { enabled: true, level: 'moderate' },
                features: { vision: true, browser: true, iot: true, dev: true },
                skills: {}
            },
            proactive: {
                lastCheck: 0,
                suggested: []
            }
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

    // Activity logging (sensitive tokens are redacted before storage)
    logActivity(message, type = 'info') {
        const entry = {
            timestamp: new Date(),
            message: redact(message),
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
            
            if (aliceState === 'PROCESSING' || aliceState === 'UNDERSTANDING') baseCpu = 35;
            else if (aliceState === 'SELECTING_TOOL') baseCpu = 25;
            else if (aliceState === 'EXECUTING') baseCpu = 50;
            else if (aliceState === 'SPEAKING') baseCpu = 25;
            else if (aliceState === 'LISTENING') baseCpu = 30;
            
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

    // Skill state methods
    setSkillState(skillName, result) {
        this._state.skill.currentSkill = skillName;
        this._state.skill.lastSkill = skillName;
        this._state.skill.executionHistory.push({
            skill: skillName,
            result: result,
            timestamp: Date.now()
        });
        
        // Keep only last 10 executions
        if (this._state.skill.executionHistory.length > 10) {
            this._state.skill.executionHistory.shift();
        }
        
        this._notify('skill', this._state.skill);
    }

    getSkillState() {
        return { ...this._state.skill };
    }

    clearSkillState() {
        this._state.skill.currentSkill = null;
        this._notify('skill', this._state.skill);
    }

    // ============ TASK / AGENT STATE (Part 4) ============

    getTask() {
        // Return a deep clone so consumers can't mutate internal state directly
        return JSON.parse(JSON.stringify(this._state.task));
    }

    setTask(updates) {
        Object.assign(this._state.task, updates);
        this._state.task.updatedAt = Date.now();
        this._notify('task', this.getTask());
    }

    resetTask() {
        this._state.task = {
            active: false,
            goal: '',
            status: 'idle',
            plan: [],
            currentStepIndex: -1,
            currentAction: '',
            progress: 0,
            result: null,
            error: null,
            updatedAt: null
        };
        this._notify('task', this.getTask());
    }

    updateTaskStep(stepIndex, patch) {
        if (!this._state.task.plan[stepIndex]) return;
        Object.assign(this._state.task.plan[stepIndex], patch);
        this._state.task.updatedAt = Date.now();
        this._notify('task', this.getTask());
    }

    // ============ NOTIFICATIONS (Part 5) ============

    notify(message, type = 'info', { duration = 5000 } = {}) {
        const n = { id: Date.now() + Math.random(), message: redact(message), type, duration };
        this._state.notifications.unshift(n);
        if (this._state.notifications.length > 8) this._state.notifications.pop();
        this._notify('notifications', [...this._state.notifications]);
        return n.id;
    }

    dismissNotification(id) {
        this._state.notifications = this._state.notifications.filter(n => n.id !== id);
        this._notify('notifications', [...this._state.notifications]);
    }

    getNotifications() {
        return [...this._state.notifications];
    }

    // ============ SETTINGS (Part 5) ============

    getSettings() {
        return JSON.parse(JSON.stringify(this._state.settings));
    }

    setSettings(patch) {
        Object.assign(this._state.settings, patch);
        this._notify('settings', this.getSettings());
    }

    updateSetting(group, key, value) {
        if (!this._state.settings[group]) this._state.settings[group] = {};
        this._state.settings[group][key] = value;
        this._notify('settings', this.getSettings());
    }

    // ============ MEMORY (Part 5 UI) ============

    notifyMemoryChanged() {
        this._notify('memory', Date.now());
    }

    // ============ PROACTIVE (Part 5) ============

    recordSuggestion(text) {
        this._state.proactive.suggested.push({ text, at: Date.now() });
        this._state.proactive.lastCheck = Date.now();
        if (this._state.proactive.suggested.length > 50) {
            this._state.proactive.suggested.shift();
        }
        this._notify('proactive', { ...this._state.proactive });
    }
}

// Singleton instance
export const state = new StateManager();
