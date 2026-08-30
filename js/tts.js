/**
 * ALICE Text-to-Speech Module
 * Adapter pattern for multiple TTS providers
 * Uses Web Speech API with natural-sounding configuration
 */
import { state } from './state.js';

class TTSAdapter {
    constructor() {
        this._synth = window.speechSynthesis;
        this._voices = [];
        this._selectedVoice = null;
        this._isSpeaking = false;
        this._isPaused = false;
        this._onStart = null;
        this._onEnd = null;
        this._onError = null;
        this._onBoundary = null;
        this._currentUtterance = null;
        
        // Natural speech settings
        this._rate = 0.95; // Slightly slower for clarity
        this._pitch = 1.0;
        this._volume = 1.0;
        
        this._initVoices();
    }

    /**
     * Initialize voices
     */
    _initVoices() {
        if (!this._synth) {
            state.logActivity('Speech Synthesis not supported in this browser', 'warning');
            return;
        }

        // Voices may load async
        const loadVoices = () => {
            this._voices = this._synth.getVoices();
            this._selectBestVoice();
        };

        loadVoices();
        
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.onvoiceschanged = loadVoices;
        }
    }

    /**
     * Select the best available voice for natural speech
     */
    _selectBestVoice() {
        if (this._voices.length === 0) return;

        // Prefer female English voices for a more natural feel
        const preferences = [
            // Google English (typically high quality)
            v => v.name.includes('Google') && v.lang.startsWith('en') && v.name.includes('Female'),
            v => v.name.includes('Google') && v.lang.startsWith('en-GB') && v.name.includes('Female'),
            v => v.name.includes('Google') && v.lang.startsWith('en-US') && v.name.includes('Female'),
            // Microsoft English
            v => v.name.includes('Microsoft') && v.lang.startsWith('en') && v.name.includes('Female'),
            v => v.name.includes('Microsoft') && v.lang.startsWith('en-GB'),
            // Safari/Apple
            v => v.name.includes('Samantha') && v.lang.startsWith('en'),
            v => v.name.includes('Karen') && v.lang.startsWith('en-AU'),
            // Standard female English
            v => v.lang === 'en-US' && (v.name.includes('Female') || v.name.includes('Zira') || v.name.includes('Susan')),
            v => v.lang === 'en-GB',
            // Any English female voice
            v => v.lang.startsWith('en') && (v.name.includes('female') || v.name.includes('Woman')),
            // Fallback to any English voice
            v => v.lang.startsWith('en')
        ];

        for (const preference of preferences) {
            const voice = this._voices.find(preference);
            if (voice) {
                this._selectedVoice = voice;
                state.logActivity(`Selected voice: ${voice.name}`, 'info');
                return;
            }
        }

        // Ultimate fallback
        this._selectedVoice = this._voices[0];
    }

    /**
     * Check if TTS is available
     */
    isAvailable() {
        return !!this._synth;
    }

    /**
     * Get available voices
     */
    getVoices() {
        return this._voices;
    }

    /**
     * Select a specific voice by name
     */
    selectVoice(voiceName) {
        const voice = this._voices.find(v => v.name === voiceName);
        if (voice) {
            this._selectedVoice = voice;
            return true;
        }
        return false;
    }

    /**
     * Set speech rate (0.1 - 10)
     */
    setRate(rate) {
        this._rate = Math.max(0.1, Math.min(10, rate));
    }

    /**
     * Set pitch (0 - 2)
     */
    setPitch(pitch) {
        this._pitch = Math.max(0, Math.min(2, pitch));
    }

    /**
     * Set volume (0 - 1)
     */
    setVolume(volume) {
        this._volume = Math.max(0, Math.min(1, volume));
    }

    /**
     * Set callbacks
     */
    onStart(callback) { this._onStart = callback; }
    onEnd(callback) { this._onEnd = callback; }
    onError(callback) { this._onError = callback; }
    onBoundary(callback) { this._onBoundary = callback; }

    /**
     * Speak text
     */
    speak(text) {
        if (!this._synth) {
            state.logActivity('Cannot speak: TTS not available', 'danger');
            return false;
        }

        // Cancel any current speech
        this._synth.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        
        // Apply settings
        utterance.voice = this._selectedVoice;
        utterance.rate = this._rate;
        utterance.pitch = this._pitch;
        utterance.volume = this._volume;
        
        // Set language if voice not set
        if (!this._selectedVoice) {
            utterance.lang = 'en-US';
        }

        // Event handlers
        utterance.onstart = () => {
            this._isSpeaking = true;
            state.logActivity('Speaking started', 'info');
            if (this._onStart) this._onStart();
        };

        utterance.onend = () => {
            this._isSpeaking = false;
            this._isPaused = false;
            state.logActivity('Speaking ended', 'info');
            if (this._onEnd) this._onEnd();
        };

        utterance.onerror = (event) => {
            this._isSpeaking = false;
            
            if (event.error !== 'canceled' && event.error !== 'interrupted') {
                state.logActivity(`Speech error: ${event.error}`, 'warning');
                if (this._onError) this._onError(event.error);
            }
        };

        utterance.onboundary = (event) => {
            if (this._onBoundary) {
                this._onBoundary({
                    charIndex: event.charIndex,
                    charLength: event.charLength,
                    text: event.name
                });
            }
        };

        this._currentUtterance = utterance;
        
        try {
            this._synth.speak(utterance);
            return true;
        } catch (error) {
            state.logActivity(`Speech failed: ${error.message}`, 'danger');
            return false;
        }
    }

    /**
     * Pause current speech
     */
    pause() {
        if (this._synth && this._isSpeaking && !this._isPaused) {
            this._synth.pause();
            this._isPaused = true;
            state.logActivity('Speech paused', 'info');
        }
    }

    /**
     * Resume paused speech
     */
    resume() {
        if (this._synth && this._isPaused) {
            this._synth.resume();
            this._isPaused = false;
            state.logActivity('Speech resumed', 'info');
        }
    }

    /**
     * Stop speaking
     */
    stop() {
        if (this._synth) {
            this._synth.cancel();
            this._isSpeaking = false;
            this._isPaused = false;
            this._currentUtterance = null;
        }
    }

    /**
     * Check if currently speaking
     */
    isSpeaking() {
        return this._isSpeaking;
    }

    /**
     * Check if paused
     */
    isPaused() {
        return this._isPaused;
    }

    /**
     * Check if TTS is ready
     */
    isReady() {
        return this._synth && this._voices.length > 0;
    }
}

// Create singleton
export const tts = new TTSAdapter();
