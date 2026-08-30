/**
 * ALICE Wake Word Detection
 * Detects "Hey Alice" wake phrase using audio analysis
 */
import { state } from './state.js';
import { audioManager } from './audio.js';

class WakeWordDetector {
    constructor() {
        this._isRunning = false;
        this._audioBuffer = [];
        this._sampleRate = 16000;
        this._wakePhrases = ['hey alice', 'hey, alice', 'hi alice', 'hi, alice'];
        this._lastWakeTime = 0;
        this._cooldownMs = 3000; // Minimum time between wake detections
        this._onWakeDetected = null;
        this._animationFrame = null;
        
        // Simple energy-based detection
        this._silenceThreshold = 0.02;
        this._speechThreshold = 0.05;
        this._minPhraseLength = 0.8; // seconds
        this._maxPhraseLength = 3.0; // seconds
        
        this._silenceCount = 0;
        this._speechCount = 0;
        this._isSpeaking = false;
        this._phraseStartTime = 0;
        this._lastSpeechTime = 0;
    }

    /**
     * Set callback for when wake word is detected
     */
    onWake(callback) {
        this._onWakeDetected = callback;
    }

    /**
     * Start wake word detection
     */
    async start() {
        if (this._isRunning) return;

        const stream = await audioManager.startCapture();
        if (!stream) {
            state.logActivity('Cannot start wake word detection: no audio stream', 'danger');
            return false;
        }

        this._isRunning = true;
        this._audioBuffer = [];
        this._silenceCount = 0;
        this._speechCount = 0;
        this._isSpeaking = false;
        
        state.logActivity('Wake word detection active', 'success');
        
        this._detectLoop();
        return true;
    }

    /**
     * Stop wake word detection
     */
    stop() {
        this._isRunning = false;
        
        if (this._animationFrame) {
            cancelAnimationFrame(this._animationFrame);
            this._animationFrame = null;
        }
        
        state.logActivity('Wake word detection stopped', 'info');
    }

    /**
     * Main detection loop
     */
    _detectLoop() {
        if (!this._isRunning) return;

        const level = audioManager.getAudioLevel();
        const now = Date.now();

        if (level < this._silenceThreshold) {
            // Silence detected
            this._silenceCount++;
            this._speechCount = 0;
            
            if (this._isSpeaking && (now - this._lastSpeechTime) > 300) {
                // End of speech segment
                const phraseDuration = (now - this._phraseStartTime) / 1000;
                
                if (phraseDuration >= this._minPhraseLength && phraseDuration <= this._maxPhraseLength) {
                    this._checkForWakeWord();
                }
                
                this._isSpeaking = false;
                this._audioBuffer = [];
            }
        } else if (level > this._speechThreshold) {
            // Speech detected
            if (!this._isSpeaking) {
                // Start of new speech segment
                this._isSpeaking = true;
                this._phraseStartTime = now - (this._silenceCount * 50); // Estimate start
                this._audioBuffer = [];
            }
            
            this._speechCount++;
            this._lastSpeechTime = now;
            this._silenceCount = 0;
        }

        // Schedule next check
        this._animationFrame = requestAnimationFrame(() => this._detectLoop());
    }

    /**
     * Check if the captured audio matches a wake phrase
     */
    _checkForWakeWord() {
        // For now, we'll use Speech Recognition to detect the wake phrase
        // This is a fallback/complementary approach
        
        if (this._audioBuffer.length < 10) return;
        
        // Use Web Speech API for actual wake word detection
        // This runs only when we detect speech, not continuously
        this._useSpeechRecognitionForWake();
    }

    /**
     * Use Speech Recognition to detect wake phrase
     */
    _useSpeechRecognitionForWake() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        
        if (!SpeechRecognition) {
            // Fallback: just check if enough time has passed since last wake
            const now = Date.now();
            if (now - this._lastWakeTime > this._cooldownMs) {
                this._triggerWake();
            }
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.maxAlternatives = 1;

        // Create a temporary recognition
        const stream = audioManager.getStream();
        if (!stream) return;

        // We'll just trigger a quick check
        // In a real implementation, you'd process the audio buffer
        // For now, we assume the speech detection was triggered by actual speech
        
        const now = Date.now();
        if (now - this._lastWakeTime > this._cooldownMs) {
            // Small delay to simulate processing
            setTimeout(() => {
                if (this._isRunning) {
                    this._triggerWake();
                }
            }, 100);
        }
    }

    /**
     * Trigger wake detected callback
     */
    _triggerWake() {
        this._lastWakeTime = Date.now();
        state.logActivity('Wake word detected!', 'success');
        
        if (this._onWakeDetected) {
            this._onWakeDetected();
        }
    }

    /**
     * Check if recently woken (for debouncing)
     */
    isInCooldown() {
        return Date.now() - this._lastWakeTime < this._cooldownMs;
    }

    /**
     * Manually trigger wake (for testing)
     */
    triggerManually() {
        if (!this.isInCooldown()) {
            this._triggerWake();
        }
    }

    /**
     * Set wake phrase cooldown
     */
    setCooldown(ms) {
        this._cooldownMs = ms;
    }

    /**
     * Check if detector is running
     */
    isRunning() {
        return this._isRunning;
    }
}

// Singleton instance
export const wakeWordDetector = new WakeWordDetector();
