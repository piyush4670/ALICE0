/**
 * ALICE Main Application — Visual Reconstruction 1B
 * Entry point for the ALICE interface
 *
 * Stage 1A: voice is OFF until the user explicitly enables the
 * microphone. No automatic permission request at startup. All voice
 * lifecycle transitions live in the ConversationManager; this module
 * only forwards user intent (Mic / Wake / Stop / text input).
 *
 * Stage 1B: UI restructured into assistant-focused layout. Debug
 * functionality moved to a separated drawer. All functional
 * architecture preserved unchanged.
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { auth } from './auth.js';
import { bootSequence } from './boot.js';
import { hud } from './hud.js';
import { conversation } from './conversation.js';
import { settings } from './settings.js';
import { proactive } from './proactive.js';
import { delay } from './utils.js';

class ALICEApp {
    constructor() {
        this._screens = {};
        this._currentScreen = null;
        this._voiceEnableInFlight = false;
    }

    async init() {
        console.log(`%c ALICE Interface v${CONFIG.system.version} (${CONFIG.system.codename}) `,
            'background: #6C8EEF; color: #0b0e17; font-weight: bold; padding: 4px 8px; border-radius: 4px;');
        console.log('%c Voice Systems: On-demand (microphone stays OFF until enabled) ',
            'background: #4AE3B5; color: #0b0e17; padding: 4px 8px; border-radius: 4px;');

        // Cache screen elements
        this._screens.auth = document.getElementById('auth-screen');
        this._screens.boot = document.getElementById('boot-screen');
        this._screens.hud = document.getElementById('hud-screen');

        // Setup event listeners
        this._setupAuthEvents();
        this._setupDebugControls();
        this._setupVoiceControls();
        this._setupConversationBindings();
        this._setupCommandInput();
        this._setupAgentDemos();

        // Start time updates
        state.startTimeUpdates();

        // Load and apply user settings
        settings.init();

        // Show auth screen
        this._showScreen('auth');
    }

    _showScreen(screenName) {
        Object.values(this._screens).forEach(screen => {
            if (screen) screen.classList.remove('active');
        });

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

        const form = authScreen.querySelector('.auth-form');
        const input = authScreen.querySelector('.auth-input');
        const pinDots = authScreen.querySelectorAll('.pin-dot');

        input?.addEventListener('input', (e) => {
            const value = e.target.value;

            pinDots.forEach((dot, index) => {
                if (index < value.length) {
                    dot.classList.add('filled');
                } else {
                    dot.classList.remove('filled');
                }
            });

            const status = authScreen.querySelector('.auth-status');
            if (status) {
                status.classList.remove('error', 'success');
            }
        });

        form?.addEventListener('submit', async (e) => {
            e.preventDefault();

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
        state.notify('Core systems ready — how can I help?', 'success');

        // Start proactive assistance (respects settings)
        proactive.start();

        // Voice is NOT started here (Stage 1A)
        conversation.syncBootState();
    }

    // ==================================================================
    // Voice (Stage 1A — preserved exactly)
    // ==================================================================

    _setupConversationBindings() {
        conversation.onWakeWord(() => {
            state.clearTranscript();
        });

        conversation.onSpeechResult((result) => {
            state.setTranscript(result.text);
        });

        conversation.onAliceSpeak((text) => {
            state.setLastResponse(text);
        });
    }

    async _enableVoice() {
        if (this._voiceEnableInFlight) return;
        if (state.getVoiceState().isActive) return;

        this._voiceEnableInFlight = true;
        try {
            const result = await conversation.enableVoice();

            if (result.started) {
                state.logActivity('Voice system ready — say "Hey Alice" or press Wake', 'success');
            } else if (!result.permission) {
                state.notify('Voice unavailable — microphone access denied. Text commands still work.', 'warning');
            }
        } finally {
            this._voiceEnableInFlight = false;
        }
    }

    _disableVoice() {
        conversation.stop();
        state.logActivity('Voice system disabled', 'info');
    }

    _setupVoiceControls() {
        const wakeButton = document.getElementById('voice-wake-btn');
        wakeButton?.addEventListener('click', () => {
            if (!conversation.triggerWakeWord()) {
                state.notify('Voice is OFF — press Mic to enable it first', 'info');
            }
        });

        const stopButton = document.getElementById('voice-stop-btn');
        stopButton?.addEventListener('click', () => {
            conversation.stopAllActivity();
        });

        const micToggle = document.getElementById('mic-toggle');
        micToggle?.addEventListener('click', () => {
            const voiceState = state.getVoiceState();
            if (voiceState.isActive) {
                this._disableVoice();
            } else {
                this._enableVoice();
            }
        });
    }

    _setupCommandInput() {
        const form = document.getElementById('command-form');
        const input = document.getElementById('command-input');
        if (!form || !input) return;

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            state.setTranscript(text);
            conversation.processText(text);
        });
    }

    _setupAgentDemos() {
        const researchBtn = document.getElementById('demo-research-btn');
        researchBtn?.addEventListener('click', () => {
            conversation.processText('research quantum computing, summarize the important information and create a document');
        });

        const confirmBtn = document.getElementById('demo-confirm-btn');
        confirmBtn?.addEventListener('click', () => {
            conversation.processText('delete my note');
        });
    }

    _setupDebugControls() {
        const debugPanel = document.getElementById('debug-panel');
        if (!debugPanel) return;

        // State simulation buttons
        const stateButtons = debugPanel.querySelectorAll('[data-state]');
        stateButtons.forEach(button => {
            button.addEventListener('click', () => {
                const targetState = button.dataset.state;
                state.set('aliceState', targetState);

                stateButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
            });
        });

        // Voice debug
        const voiceTestBtn = debugPanel.querySelector('#voice-test-btn');
        voiceTestBtn?.addEventListener('click', () => {
            if (!conversation.triggerWakeWord()) {
                state.notify('Voice is OFF — press Mic to enable it first', 'info');
            }
        });

        // Logout
        const logoutBtn = debugPanel.querySelector('#logout-btn');
        logoutBtn?.addEventListener('click', () => {
            hud.destroy();
            conversation.stop();
            auth.logout();
            this._showScreen('auth');

            const input = this._screens.auth?.querySelector('.auth-input');
            const status = this._screens.auth?.querySelector('.auth-status');
            const dots = this._screens.auth?.querySelectorAll('.pin-dot');

            if (input) input.value = '';
            if (status) {
                status.textContent = '';
                status.className = 'auth-status';
            }
            if (dots) dots.forEach(dot => dot.classList.remove('filled'));
        });

        // Toggle debug panel (slide-out drawer)
        const toggleBtn = document.getElementById('debug-toggle');
        const closeBtn = debugPanel.querySelector('.debug-close');

        toggleBtn?.addEventListener('click', () => {
            debugPanel.classList.add('visible');
            debugPanel.setAttribute('aria-hidden', 'false');
        });

        closeBtn?.addEventListener('click', () => {
            debugPanel.classList.remove('visible');
            debugPanel.setAttribute('aria-hidden', 'true');
        });

        // Close debug panel when clicking outside
        document.addEventListener('click', (e) => {
            if (debugPanel.classList.contains('visible') &&
                !debugPanel.contains(e.target) &&
                e.target !== toggleBtn &&
                !toggleBtn.contains(e.target)) {
                debugPanel.classList.remove('visible');
                debugPanel.setAttribute('aria-hidden', 'true');
            }
        });
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new ALICEApp();
    app.init();
});
