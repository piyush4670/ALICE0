/**
 * ALICE Wake Word Detection
 * ------------------------------------------------------------------
 * IMPORTANT HONESTY NOTE (Stage 1A, updated Phase 1.2B):
 * This module does NOT perform true "Hey Alice" phrase verification.
 * It is an energy-based VOICE-ACTIVITY placeholder: when the microphone
 * picks up a speech-length burst of audio (0.8–3.0 s) measured on the
 * NORMALIZED TIME-DOMAIN RMS amplitude, and the cooldown has elapsed,
 * it reports a wake. No speech-to-phrase matching happens here, and no
 * external wake-word engine is introduced.
 * The `_wakePhrases` list is reserved for a future real engine.
 *
 * Phase 1.2B — deliberate production migration of the detector input:
 *  - The energy read moved from the legacy frequency-domain spectrum
 *    average (a smoothed, dB-mapped summary) to the normalized
 *    time-domain RMS amplitude: audioManager.getRmsAudioLevel().
 *    RMS is an AMPLITUDE measurement of the raw waveform, computed as
 *    sqrt(mean(((byte - 128) / 128)^2)) over the analyser's waveform
 *    samples.
 *  - This is still NOT a VAD: there is no speech/non-speech
 *    classification model, no noise suppression, no ML, and no
 *    automatic threshold learning — only the input metric changed.
 *  - This is still NOT actual wake-phrase recognition. It cannot tell
 *    "hey alice" from a cough, a door slam, or speech of the same
 *    duration and loudness.
 *  - The detector state machine is otherwise untouched: silence and
 *    speech counting, minimum speech duration, audio buffer handling,
 *    wake debounce, cooldown, callback behaviour, Stop behaviour,
 *    generation/session protection and cancellation all behave exactly
 *    as before.
 *  - Thresholds (silence 0.02, speech 0.05) were NOT recalibrated here.
 *    The deterministic synthetic calibration in
 *    tests/wakeRmsCalibration.test.mjs shows every speech-like fixture
 *    still clears 0.05 under RMS and every silence/very-quiet fixture
 *    stays below 0.02, so they are retained unchanged.
 *  - LIVE MICROPHONE CALIBRATION REMAINS PENDING. These numbers have
 *    never been validated against real recorded hardware, browser
 *    automatic gain control, or real room noise; they are not a
 *    calibrated voice-activity decision threshold.
 *
 * Stage 1A correctness fixes:
 *  - start() is guarded against concurrent invocations (no duplicate
 *    detection loops) and against a Stop arriving while the microphone
 *    capture is still being acquired (token-based invalidation).
 *  - stop() always invalidates in-flight starts and pending triggers.
 *  - The audio buffer is actually filled now; previously it stayed
 *    empty, so automatic wake could never fire at all.
 */
import { state } from './state.js';
import { audioManager } from './audio.js';

class WakeWordDetector {
    constructor() {
        this._isRunning = false;
        this._starting = false;
        // Monotonic token: stop() bumps it so any in-flight async start
        // or pending trigger becomes stale and aborts itself.
        this._startToken = 0;
        this._audioBuffer = [];
        this._maxBufferSamples = 256;
        this._sampleRate = 16000;
        // Reserved for a future real wake-phrase engine (unused today —
        // see the module-level honesty note).
        this._wakePhrases = ['hey alice', 'hey, alice', 'hi alice', 'hi, alice'];
        this._lastWakeTime = 0;
        this._cooldownMs = 3000; // Minimum time between wake detections
        this._onWakeDetected = null;
        this._animationFrame = null;

        // Simple energy-based detection over the normalized time-domain
        // RMS amplitude. Both thresholds are carried over UNCHANGED from
        // the legacy frequency-domain metric: Phase 1.2B deliberately
        // migrates the metric without recalibrating, and the deterministic
        // synthetic evidence (tests/wakeRmsCalibration.test.mjs) supports
        // that. Live microphone calibration is still pending — see the
        // module header.
        this._silenceThreshold = 0.02;
        this._speechThreshold = 0.05;
        this._minPhraseLength = 0.8; // seconds
        this._maxPhraseLength = 3.0; // seconds
        this._minBufferSamples = 10;

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
     * Start wake word detection.
     * Returns true when detection is running, false otherwise.
     * Safe against double-start and against Stop racing the async
     * microphone capture.
     */
    async start() {
        if (this._isRunning) return true;
        if (this._starting) return false; // a start is already in flight

        this._starting = true;
        const token = ++this._startToken;

        try {
            const stream = await audioManager.startCapture();

            // Stop was pressed (or a newer start superseded us) while we
            // were waiting for the microphone — abort, don't go live.
            if (token !== this._startToken) {
                return false;
            }

            if (!stream) {
                state.logActivity('Cannot start wake word detection: no audio stream', 'danger');
                return false;
            }

            this._isRunning = true;
            this._audioBuffer = [];
            this._silenceCount = 0;
            this._speechCount = 0;
            this._isSpeaking = false;

            state.logActivity('Wake detection active (voice-activity placeholder — no phrase verification)', 'success');

            this._detectLoop();
            return true;
        } finally {
            if (token === this._startToken) {
                this._starting = false;
            }
        }
    }

    /**
     * Stop wake word detection. Invalidates any in-flight start and any
     * pending trigger so detection cannot resurrect itself after Stop.
     */
    stop() {
        if (!this._isRunning && !this._starting) {
            return;
        }

        this._startToken++; // stale-ify in-flight start()/pending triggers
        this._isRunning = false;
        this._starting = false;

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

        // Phase 1.2B: the detector's energy input is the normalized
        // time-domain RMS amplitude of the microphone waveform. This is an
        // amplitude measurement only — NOT a VAD and NOT phrase recognition
        // (see the module header). The rest of the state machine below is
        // unchanged from the legacy-metric implementation.
        const level = audioManager.getRmsAudioLevel();
        const now = Date.now();

        // Record levels so a completed speech segment has real data behind
        // it (previously the buffer was never filled, so wake could never
        // fire automatically).
        this._audioBuffer.push(level);
        if (this._audioBuffer.length > this._maxBufferSamples) {
            this._audioBuffer.shift();
        }

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
     * A speech-length audio segment just ended. If we have enough samples
     * and the cooldown allows it, report a wake. This is voice-activity
     * detection only — the phrase content is NOT verified (see module
     * header).
     */
    _checkForWakeWord() {
        if (this._audioBuffer.length < this._minBufferSamples) return;

        const now = Date.now();
        if (now - this._lastWakeTime <= this._cooldownMs) return;

        const token = this._startToken;
        // Small delay to debounce; re-check liveness before triggering so a
        // Stop pressed in the meantime wins.
        setTimeout(() => {
            if (this._isRunning && token === this._startToken) {
                this._triggerWake();
            }
        }, 100);
    }

    /**
     * Trigger wake detected callback
     */
    _triggerWake() {
        if (!this._isRunning) return;
        this._lastWakeTime = Date.now();
        state.logActivity('Voice activity detected — wake triggered (placeholder detection)', 'success');

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
