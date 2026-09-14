/**
 * ALICE Speech-to-Text Module
 * Adapter pattern for multiple STT providers
 * Currently uses Web Speech API
 */
import { state } from './state.js';

class STTAdapter {
    constructor() {
        this._recognition = null;
        this._isListening = false;
        // True from the moment start() is requested until the session's
        // `onend` fires. Web Speech `onstart` is asynchronous, so guarding
        // stop() with `_isListening` alone allowed a zombie session to come
        // up after Stop was pressed (Stage 1A race fix).
        this._sessionActive = false;
        this._onResult = null;
        this._onError = null;
        this._onStart = null;
        this._onEnd = null;
        this._continuousMode = false;
        this._interimResults = true;

        this._initRecognition();
    }

    /**
     * Initialize Web Speech Recognition
     */
    _initRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        
        if (!SpeechRecognition) {
            state.logActivity('Speech Recognition not supported in this browser', 'warning');
            return;
        }

        this._recognition = new SpeechRecognition();
        this._recognition.continuous = false;
        this._recognition.interimResults = true;
        this._recognition.lang = 'en-US';
        this._recognition.maxAlternatives = 1;

        this._recognition.onstart = () => {
            this._isListening = true;
            this._sessionActive = true;
            state.logActivity('Speech recognition started', 'success');
            if (this._onStart) this._onStart();
        };

        this._recognition.onresult = (event) => {
            const results = [];
            let finalTranscript = '';
            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcript;
                } else {
                    interimTranscript += transcript;
                }
                results.push({
                    transcript,
                    isFinal: event.results[i].isFinal,
                    confidence: event.results[i][0].confidence
                });
            }

            if (this._onResult) {
                this._onResult({
                    final: finalTranscript.trim(),
                    interim: interimTranscript.trim(),
                    results,
                    isComplete: finalTranscript.length > 0
                });
            }
        };

        this._recognition.onerror = (event) => {
            state.logActivity(`Speech recognition error: ${event.error}`, 'warning');
            
            if (event.error === 'not-allowed') {
                state.logActivity('Microphone access denied', 'danger');
            }
            
            if (this._onError) {
                this._onError(event.error);
            }
            
            this._isListening = false;
        };

        this._recognition.onend = () => {
            this._isListening = false;
            this._sessionActive = false;
            state.logActivity('Speech recognition ended', 'info');

            if (this._onEnd) {
                this._onEnd();
            }
        };
    }

    /**
     * Check if STT is available
     */
    isAvailable() {
        return !!this._recognition;
    }

    /**
     * Set callback for recognition results
     */
    onResult(callback) {
        this._onResult = callback;
    }

    /**
     * Set callback for errors
     */
    onError(callback) {
        this._onError = callback;
    }

    /**
     * Set callback for recognition start
     */
    onStart(callback) {
        this._onStart = callback;
    }

    /**
     * Set callback for recognition end
     */
    onEnd(callback) {
        this._onEnd = callback;
    }

    /**
     * Set language
     */
    setLanguage(lang) {
        if (this._recognition) {
            this._recognition.lang = lang;
        }
    }

    /**
     * Start listening
     */
    start() {
        if (!this._recognition) {
            state.logActivity('Cannot start: Speech Recognition not available', 'danger');
            return false;
        }

        // Guard on the full session window (start requested → onend), not
        // just on `_isListening`, so we never double-start a session.
        if (this._sessionActive || this._isListening) {
            return false;
        }

        try {
            this._sessionActive = true;
            this._recognition.start();
            return true;
        } catch (error) {
            this._sessionActive = false;
            state.logActivity(`Failed to start recognition: ${error.message}`, 'danger');
            return false;
        }
    }

    /**
     * Stop listening. Works even while a session is still coming up
     * (`onstart` has not fired yet) — the session is torn down instead of
     * being allowed to go live after Stop (Stage 1A race fix).
     */
    stop() {
        if (!this._recognition || !this._sessionActive) {
            return;
        }

        try {
            this._recognition.stop();
        } catch (error) {
            // Ignore - may not be running
            this._sessionActive = false;
            this._isListening = false;
        }
    }

    /**
     * Abort recognition
     */
    abort() {
        if (!this._recognition) return;

        try {
            this._recognition.abort();
        } catch (error) {
            // Ignore
        }

        this._sessionActive = false;
        this._isListening = false;
    }

    /**
     * Check if currently listening (recognition actually receiving audio)
     */
    isListening() {
        return this._isListening;
    }

    /**
     * Check if a recognition session is active or coming up
     * (start requested, `onend` not yet fired). Callers use this to avoid
     * racing wake detection against an in-flight STT session.
     */
    hasActiveSession() {
        return this._sessionActive || this._isListening;
    }
}

// Create singleton
export const stt = new STTAdapter();
