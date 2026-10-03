/**
 * ALICE Audio Manager
 * Handles microphone access and audio analysis for wake word detection
 */
import { state } from './state.js';
import { delay } from './utils.js';

class AudioManager {
    constructor() {
        this._audioContext = null;
        this._analyser = null;
        this._mediaStream = null;
        this._source = null;
        this._isListening = false;
        // Frequency-domain bins (visualization) and time-domain waveform
        // samples (amplitude measurement) are kept in SEPARATE buffers so
        // reading one can never corrupt the other.
        this._audioData = null;      // getByteFrequencyData() target
        this._timeDomainData = null; // getByteTimeDomainData() target
        this._permissionStatus = 'prompt'; // 'prompt', 'granted', 'denied'
        // Capture race protection (Stage 1A fix): every acquisition runs
        // under a generation token; stopCapture() bumps it so a
        // getUserMedia() that resolves AFTER a Stop can never attach its
        // stream or resurrect microphone resources.
        this._captureToken = 0;
        this._captureInFlight = null;
    }

    /**
     * Check if microphone is available
     */
    isAvailable() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    /**
     * Get current permission status
     */
    getPermissionStatus() {
        return this._permissionStatus;
    }

    /**
     * Request microphone permission
     */
    async requestPermission() {
        if (!this.isAvailable()) {
            state.logActivity('Microphone not available in this browser', 'warning');
            return false;
        }

        // A cached grant is stable for the origin — re-acquiring a stream
        // just to re-confirm it would add unnecessary getUserMedia() race
        // surface (Stage 1A). If the browser later revokes access, the
        // capture itself fails and the error path handles it.
        if (this._permissionStatus === 'granted') {
            return true;
        }

        try {
            // Check permission API if available
            if (navigator.permissions && navigator.permissions.query) {
                const result = await navigator.permissions.query({ name: 'microphone' });
                if (result.state === 'denied') {
                    this._permissionStatus = 'denied';
                    state.logActivity('Microphone permission denied', 'danger');
                    return false;
                }
                if (result.state === 'granted') {
                    this._permissionStatus = 'granted';
                    return true;
                }
            }

            // Try to get the stream (will prompt if needed)
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // Stop the stream immediately - we just needed to get permission
            stream.getTracks().forEach(track => track.stop());
            
            this._permissionStatus = 'granted';
            state.logActivity('Microphone permission granted', 'success');
            return true;

        } catch (error) {
            this._permissionStatus = 'denied';
            state.logActivity(`Microphone permission error: ${error.message}`, 'danger');
            return false;
        }
    }

    /**
     * Start audio capture for wake word detection.
     * Returns a MediaStream that can be used for analysis.
     *
     * Race-safe (Stage 1A fix): the acquisition runs under a capture
     * generation token. If stopCapture() happens while getUserMedia() is
     * still pending, the token is invalidated and the late stream is
     * disposed of on arrival — never attached, never stored, and capture
     * is never marked active. Concurrent callers join the same in-flight
     * acquisition instead of opening duplicate microphone streams.
     */
    startCapture() {
        if (this._isListening) {
            return Promise.resolve(this._mediaStream);
        }

        if (!this.isAvailable()) {
            state.logActivity('Cannot start capture: microphone unavailable', 'danger');
            return Promise.resolve(null);
        }

        // Join a currently valid in-flight acquisition
        if (this._captureInFlight) {
            return this._captureInFlight;
        }

        const token = ++this._captureToken;
        let promise;
        promise = this._acquireCapture(token).finally(() => {
            // Only clear if we are still the current attempt (a Stop may
            // have made room for a fresh acquisition already).
            if (this._captureInFlight === promise) {
                this._captureInFlight = null;
            }
        });
        this._captureInFlight = promise;
        return promise;
    }

    /**
     * Internal capture acquisition bound to a capture generation token.
     */
    async _acquireCapture(token) {
        if (this._permissionStatus !== 'granted') {
            const granted = await this.requestPermission();
            if (!granted) {
                return null;
            }
            // The permission prompt is async — re-check cancellation.
            if (token !== this._captureToken) {
                return null;
            }
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 16000
                }
            });

            // Stop was pressed while getUserMedia() was pending: dispose of
            // the late stream immediately. Do NOT attach it, do NOT store
            // it, do NOT create audio resources, do NOT mark capture active.
            if (token !== this._captureToken) {
                stream.getTracks().forEach(track => track.stop());
                state.logActivity('Discarded stale microphone stream (capture cancelled)', 'info');
                return null;
            }

            this._mediaStream = stream;

            // Create audio context for analysis
            this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000
            });

            this._source = this._audioContext.createMediaStreamSource(this._mediaStream);
            this._analyser = this._audioContext.createAnalyser();
            this._analyser.fftSize = 256;
            this._analyser.smoothingTimeConstant = 0.8;

            this._source.connect(this._analyser);

            this._audioData = new Uint8Array(this._analyser.frequencyBinCount);

            // Time-domain sample buffer for waveform amplitude. Sized from
            // the analyser's FFT size — getByteTimeDomainData() fills exactly
            // fftSize samples.
            this._timeDomainData = new Uint8Array(this._analyser.fftSize);

            this._isListening = true;
            state.logActivity('Audio capture started', 'success');

            return this._mediaStream;

        } catch (error) {
            state.logActivity(`Audio capture error: ${error.message}`, 'danger');
            return null;
        }
    }

    /**
     * Stop audio capture. Invalidates any in-flight getUserMedia() so a
     * late-resolving stream can never resurrect the microphone (Stage 1A).
     */
    stopCapture() {
        // Invalidate pending acquisitions and allow a future startCapture()
        // to begin a completely fresh attempt.
        this._captureToken++;
        this._captureInFlight = null;

        if (this._mediaStream) {
            this._mediaStream.getTracks().forEach(track => track.stop());
            this._mediaStream = null;
        }

        if (this._audioContext) {
            this._audioContext.close();
            this._audioContext = null;
        }

        this._source = null;
        this._analyser = null;
        this._audioData = null;
        this._timeDomainData = null;
        this._isListening = false;

        state.logActivity('Audio capture stopped', 'info');
    }

    /**
     * Get current audio level (0-1) — LEGACY frequency-domain average.
     *
     * This is the exact metric the wake detector (wakeword.js) has always
     * consumed, preserved unchanged so Phase 1.1 does not silently alter the
     * wake path's input. It averages the getByteFrequencyData() bins divided
     * by 255 — a smoothed, dB-mapped spectrum summary, NOT a calibrated
     * waveform amplitude. It is kept for wake detection and for the existing
     * HUD waveform; the time-domain amplitude measurement lives in
     * getRmsAudioLevel().
     *
     * Returns 0 when capture or the analyser buffer is unavailable.
     */
    getAudioLevel() {
        if (!this._analyser || !this._audioData) {
            return 0;
        }

        this._analyser.getByteFrequencyData(this._audioData);
        
        // Calculate average volume
        let sum = 0;
        for (let i = 0; i < this._audioData.length; i++) {
            sum += this._audioData[i];
        }
        
        return sum / (this._audioData.length * 255);
    }

    /**
     * Get normalized time-domain RMS amplitude of the microphone waveform.
     *
     * Reads getByteTimeDomainData() into its own buffer (separate from the
     * frequency buffer used by getAudioLevel()/getFrequencyData()):
     *   sample = (byte - 128) / 128   -> normalized waveform sample
     *   level  = sqrt(mean(sample^2)) -> normalized RMS
     *
     * Range: the unsigned byte encoding is asymmetric around its 128
     * midpoint, so a sample sits in [-1, +0.9921875] (byte 0 -> -1,
     * byte 255 -> +127/128). The RMS is therefore finite in [0, 1]: 1 is
     * attainable only when EVERY sample sits on the negative rail (byte 0),
     * while the byte-255 positive rail yields 127/128 ≈ 0.99219 — i.e. the
     * positive rail does NOT reach 1. The [0, 1] clamp is a defensive bound
     * that never binds for real byte input.
     * 0 means digital silence (every sample on the midpoint 128).
     *
     * Returns 0 when capture, the analyser, or the time-domain buffer is
     * unavailable, and coerces any non-finite result to 0.
     *
     * NOTE: this is a measurement fix, not a VAD. Nothing consumes it for
     * wake detection yet, and the wake thresholds in wakeword.js were never
     * calibrated against it — recalibration is a separate, tested change.
     */
    getRmsAudioLevel() {
        if (!this._analyser || !this._timeDomainData ||
            typeof this._analyser.getByteTimeDomainData !== 'function') {
            return 0;
        }

        this._analyser.getByteTimeDomainData(this._timeDomainData);

        const samples = this._timeDomainData;
        if (samples.length === 0) {
            return 0;
        }

        let sumSquares = 0;
        for (let i = 0; i < samples.length; i++) {
            const normalized = (samples[i] - 128) / 128;
            sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / samples.length);
        if (!Number.isFinite(rms)) {
            return 0;
        }

        return Math.min(1, Math.max(0, rms));
    }

    /**
     * Get frequency data for visualization.
     * Uses its own frequency-domain buffer (frequencyBinCount bytes) and
     * never touches the time-domain buffer backing getRmsAudioLevel().
     */
    getFrequencyData() {
        if (!this._analyser || !this._audioData) {
            return new Uint8Array(0);
        }

        this._analyser.getByteFrequencyData(this._audioData);
        return this._audioData;
    }

    /**
     * Check if currently capturing
     */
    isCapturing() {
        return this._isListening;
    }

    /**
     * Get raw MediaStream
     */
    getStream() {
        return this._mediaStream;
    }

    /**
     * Get AudioContext for Speech Recognition
     */
    getAudioContext() {
        return this._audioContext;
    }
}

// Singleton instance
export const audioManager = new AudioManager();
