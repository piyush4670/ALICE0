/**
 * ALICE Main Application
 * Entry point for the ALICE interface
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { auth } from './auth.js';
import { bootSequence } from './boot.js';
import { hud } from './hud.js';
import { audioManager } from './audio.js';
import { conversation } from './conversation.js';
import { delay } from './utils.js';

class ALICEApp {
    constructor() {
        this._screens = {};
        this._currentScreen = null;
    }

    async init() {
        console.log(`%c ALICE Interface v${CONFIG.system.version} (${CONFIG.system.codename}) `, 
            'background: #00f0ff; color: #0a0a0f; font-weight: bold; padding: 4px 8px; border-radius: 4px;');
        console.log('%c Voice Systems: Part 2 Active ', 
            'background: #00ff88; color: #0a0a0f; padding: 4px 8px; border-radius: 4px;');
        
        // Cache screen elements
        this._screens.auth = document.getElementById('auth-screen');
        this._screens.boot = document.getElementById('boot-screen');
        this._screens.hud = document.getElementById('hud-screen');

        // Setup event listeners
        this._setupAuthEvents();
        this._setupDebugControls();
        this._setupVoiceControls();

        // Start time updates
        state.startTimeUpdates();

        // Show auth screen
        this._showScreen('auth');
    }

    _showScreen(screenName) {
        // Hide all screens
        Object.values(this._screens).forEach(screen => {
            if (screen) screen.classList.remove('active');
        });

        // Show target screen
        const targetScreen = this._screens[screenName];
        if (targetScreen) {
            targetScreen.classList.add('active');
            this._currentScreen = screenName;
            state.set('currentScreen', screenName);
        }
    }

    _setupAuthEvents() {
        const authScreen = this._screens.auth;
        if (!authScreen) return;

        const input = authScreen.querySelector('.auth-input');
        const button = authScreen.querySelector('.auth-button');
        const pinDots = authScreen.querySelectorAll('.pin-dot');

        // Input handling
        input?.addEventListener('input', (e) => {
            const value = e.target.value;
            
            // Update pin dots
            pinDots.forEach((dot, index) => {
                if (index < value.length) {
                    dot.classList.add('filled');
                } else {
                    dot.classList.remove('filled');
                }
            });

            // Clear error state on new input
            const status = authScreen.querySelector('.auth-status');
            if (status) {
                status.classList.remove('error', 'success');
            }
        });

        // Enter key submission
        input?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                button?.click();
            }
        });

        // Button click
        button?.addEventListener('click', async () => {
            if (auth.isLocked()) {
                return;
            }

            const pin = input?.value || '';
            
            if (pin.length === 0) {
                const status = authScreen.querySelector('.auth-status');
                if (status) {
                    status.textContent = 'Please enter your PIN';
                    status.classList.add('error');
                }
                return;
            }

            const result = await auth.authenticate(pin, authScreen);
            
            if (result.success) {
                await delay(500);
                this._startBootSequence();
            }
        });
    }

    async _startBootSequence() {
        this._showScreen('boot');
        
        // Update boot items to include voice systems
        const itemsContainer = this._screens.boot?.querySelector('.boot-items');
        if (itemsContainer) {
            const bootItems = bootSequence.bootItems;
            itemsContainer.innerHTML = bootItems.map(item => `
                <div class="boot-item" data-item-id="${item.id}">
                    <span class="boot-item-icon">${item.icon}</span>
                    <span class="boot-item-name">${item.name}</span>
                    <span class="boot-item-status">Pending</span>
                </div>
            `).join('');
        }

        await bootSequence.start(this._screens.boot);
        
        await delay(500);
        this._showHUD();
    }

    _showHUD() {
        this._showScreen('hud');
        hud.init(this._screens.hud);
        
        state.logActivity('Welcome to ALICE', 'success');
        
        // Start voice system after a short delay
        setTimeout(() => {
            this._initVoiceSystem();
        }, 1000);
    }

    async _initVoiceSystem() {
        // Request microphone permission
        const hasPermission = await audioManager.requestPermission();
        
        state.setVoiceState('isMicrophoneAvailable', audioManager.isAvailable());
        state.setVoiceState('isMicrophonePermission', hasPermission);
        
        if (!hasPermission) {
            state.logActivity('Microphone access required for voice features', 'warning');
            return;
        }
        
        // Start conversation system
        const started = await conversation.start();
        
        if (started) {
            state.setVoiceState('isActive', true);
            state.logActivity('Voice system ready - say "Hey Alice" to activate', 'success');
            
            // Setup conversation callbacks for HUD
            conversation.onWakeWord(() => {
                state.setVoiceState('isListening', true);
            });
            
            conversation.onSpeechResult((result) => {
                state.setTranscript(result.text);
            });
            
            conversation.onAliceSpeak((text) => {
                state.setLastResponse(text);
            });
        }
    }

    // Voice control buttons
    _setupVoiceControls() {
        // Manual wake button
        const wakeButton = document.getElementById('voice-wake-btn');
        wakeButton?.addEventListener('click', () => {
            if (conversation.isActive()) {
                conversation.triggerWakeWord();
            }
        });
        
        // Stop speaking button
        const stopButton = document.getElementById('voice-stop-btn');
        stopButton?.addEventListener('click', () => {
            if (conversation.isListening()) {
                // Stop listening
            }
            conversation.stopSpeaking();
        });
        
        // Microphone toggle
        const micToggle = document.getElementById('mic-toggle');
        micToggle?.addEventListener('click', () => {
            const voiceState = state.getVoiceState();
            if (voiceState.isActive) {
                conversation.stop();
                state.setVoiceState('isActive', false);
                state.logActivity('Voice system disabled', 'info');
            } else {
                this._initVoiceSystem();
            }
        });
    }

    // Debug controls for testing states
    _setupDebugControls() {
        const debugPanel = document.getElementById('debug-panel');
        if (!debugPanel) return;

        const stateButtons = debugPanel.querySelectorAll('[data-state]');
        stateButtons.forEach(button => {
            button.addEventListener('click', () => {
                const targetState = button.dataset.state;
                state.set('aliceState', targetState);
                
                // Update active button
                stateButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
            });
        });

        // Voice debug section
        const voiceTestBtn = debugPanel.querySelector('#voice-test-btn');
        voiceTestBtn?.addEventListener('click', () => {
            if (conversation.isActive()) {
                conversation.triggerWakeWord();
            }
        });

        const logoutBtn = debugPanel.querySelector('#logout-btn');
        logoutBtn?.addEventListener('click', () => {
            hud.destroy();
            conversation.stop();
            auth.logout();
            this._showScreen('auth');
            
            // Reset auth screen
            const input = this._screens.auth?.querySelector('.auth-input');
            const status = this._screens.auth?.querySelector('.auth-status');
            const dots = this._screens.auth?.querySelectorAll('.pin-dot');
            
            if (input) input.value = '';
            if (status) {
                status.textContent = '';
                status.className = 'auth-status';
            }
            if (dots) dots.forEach(dot => dot.classList.remove('filled'));
            
            // Reset voice state
            state.setVoiceState('isActive', false);
            state.setVoiceState('isListening', false);
        });

        // Toggle debug panel
        const toggleBtn = document.getElementById('debug-toggle');
        const closeBtn = debugPanel.querySelector('.debug-close');
        
        toggleBtn?.addEventListener('click', () => {
            debugPanel.classList.add('visible');
        });
        
        closeBtn?.addEventListener('click', () => {
            debugPanel.classList.remove('visible');
        });
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new ALICEApp();
    app.init();
});
