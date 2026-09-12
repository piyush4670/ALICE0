/**
 * ALICE Main Application
 * Entry point for the ALICE interface
 *
 * Stage 1A: voice is OFF until the user explicitly enables the
 * microphone. No automatic permission request at startup. All voice
 * lifecycle transitions live in the ConversationManager; this module
 * only forwards user intent (Mic / Wake / Stop / text input).
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { VOICE_STATUS } from './voiceStatus.js';
import { auth } from './auth.js';
import { bootSequence } from './boot.js';
import { hud } from './hud.js';
import { audioManager } from './audio.js';
import { conversation } from './conversation.js';
import { settings } from './settings.js';
import { proactive } from './proactive.js';
import { delay } from './utils.js';

class ALICEApp {
    constructor() {
        this._screens = {};
        this._currentScreen = null;
        // Guards against double-enabling voice (double-click / racing flows)
        this._voiceEnableInFlight = false;
    }

    async init() {
        console.log(`%c ALICE Interface v${CONFIG.system.version} (${CONFIG.system.codename}) `,
            'background: #00f0ff; color: #0a0a0f; font-weight: bold; padding: 4px 8px; border-radius: 4px;');
        console.log('%c Voice Systems: On-demand (microphone stays OFF until enabled) ',
            'background: #00ff88; color: #0a0a0f; padding: 4px 8px; border-radius: 4px;');

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

        // Load and apply user settings (Part 5)
        settings.init();

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

        const form = authScreen.querySelector('.auth-form');
        const input = authScreen.querySelector('.auth-input');
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

        // Submission (covers both the Access System button and Enter).
        // preventDefault() stops the browser's native form submission,
        // which would otherwise navigate/reload the page and abort the
        // in-flight verification.
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
        state.notify('Systems online — how can I help?', 'success');

        // Start proactive assistance (respects settings)
        proactive.start();

        // Stage 1A: voice is NOT started here. No microphone permission
        // request happens automatically — the system boots to:
        //   ALICE — READY — Voice OFF
        // The user explicitly enables voice with the Mic button.
        state.setVoiceState('isMicrophoneAvailable', audioManager.isAvailable());
        state.setVoiceStatus(VOICE_STATUS.OFF);
    }

    // ==================================================================
    // Voice (Stage 1A)
    // ==================================================================

    /**
     * Register the conversation → state bindings exactly once. The HUD
     * observes state; these callbacks just mirror conversation events
     * into state. No UI module decides lifecycle on its own anymore.
     */
    _setupConversationBindings() {
        conversation.onWakeWord(() => {
            // Clear any stale transcript when a fresh interaction starts.
            // (The LISTENING flag is driven by the real STT start event —
            // never optimistically here.)
            state.clearTranscript();
        });

        conversation.onSpeechResult((result) => {
            state.setTranscript(result.text);
        });

        conversation.onAliceSpeak((text) => {
            state.setLastResponse(text);
        });
    }

    /**
     * Explicitly enable the voice system:
     *   Mic → permission request → granted → Voice READY
     * On denial the system reports "Voice unavailable" and text
     * interaction keeps working normally.
     */
    async _enableVoice() {
        if (this._voiceEnableInFlight) return;
        if (state.getVoiceState().isActive) return;

        this._voiceEnableInFlight = true;
        try {
            state.setVoiceState('isMicrophoneAvailable', audioManager.isAvailable());

            const hasPermission = await audioManager.requestPermission();
            state.setVoiceState('isMicrophonePermission', hasPermission);

            if (!hasPermission) {
                state.setVoiceStatus(VOICE_STATUS.ERROR, 'Voice unavailable — microphone access denied');
                state.logActivity('Microphone access denied — voice disabled; text input still works', 'warning');
                state.notify('Voice unavailable — microphone access denied. Text commands still work.', 'warning');
                return;
            }

            const started = await conversation.start();
            if (!started) {
                state.setVoiceStatus(VOICE_STATUS.ERROR, 'Voice unavailable');
                state.logActivity('Voice system could not start (missing browser support?)', 'warning');
                return;
            }

            state.logActivity('Voice system ready — say "Hey Alice" or press Wake', 'success');
        } finally {
            this._voiceEnableInFlight = false;
        }
    }

    /**
     * Explicitly disable the voice system (Mic toggle OFF). Everything is
     * torn down and the microphone is released.
     */
    _disableVoice() {
        conversation.stop();
        state.logActivity('Voice system disabled', 'info');
    }

    // Voice control buttons
    _setupVoiceControls() {
        // Manual wake button — preserved in Stage 1A. Works whenever the
        // voice system is enabled, even if wake detection is paused.
        const wakeButton = document.getElementById('voice-wake-btn');
        wakeButton?.addEventListener('click', () => {
            if (!conversation.triggerWakeWord()) {
                state.notify('Voice is OFF — press Mic to enable it first', 'info');
            }
        });

        // Stop button (Stage 1A fix): actually stops STT, TTS and wake
        // detection, prevents stale auto-restarts, and returns the system
        // to a valid idle state. Previously this only called
        // stopSpeaking() — which even re-armed wake detection.
        const stopButton = document.getElementById('voice-stop-btn');
        stopButton?.addEventListener('click', () => {
            conversation.stopAllActivity();
        });

        // Microphone toggle — the ONLY way voice gets enabled/disabled
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

    // Text command input (Part 4) — lets the user drive multi-step tasks
    // without needing the microphone (useful for testing/demo environments).
    // Stage 1A: this path works with voice OFF and is never blocked by the
    // voice lifecycle.
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

    // Demo triggers for agentic tasks (Part 4)
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

    // Debug controls for testing states (kept in Stage 1A; full debug UI
    // separation happens in Stage 1B)
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

        // Voice debug section — manual wake trigger
        const voiceTestBtn = debugPanel.querySelector('#voice-test-btn');
        voiceTestBtn?.addEventListener('click', () => {
            if (!conversation.triggerWakeWord()) {
                state.notify('Voice is OFF — press Mic to enable it first', 'info');
            }
        });

        const logoutBtn = debugPanel.querySelector('#logout-btn');
        logoutBtn?.addEventListener('click', () => {
            hud.destroy();
            conversation.stop(); // releases mic, STT, TTS, wake; sets Voice OFF
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
