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
        this._audioData = null;
        this._permissionStatus = 'prompt'; // 'prompt', 'granted', 'denied'
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
     * Start audio capture for wake word detection
     * Returns a MediaStream that can be used for analysis
     */
    async startCapture() {
        if (this._isListening) {
            return this._mediaStream;
        }

        if (!this.isAvailable()) {
            state.logActivity('Cannot start capture: microphone unavailable', 'danger');
            return null;
        }

        if (this._permissionStatus !== 'granted') {
            const granted = await this.requestPermission();
            if (!granted) {
                return null;
            }
        }

        try {
            this._mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 16000
                }
            });

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
            
            this._isListening = true;
            state.logActivity('Audio capture started', 'success');
            
            return this._mediaStream;

        } catch (error) {
            state.logActivity(`Audio capture error: ${error.message}`, 'danger');
            return null;
        }
    }

    /**
     * Stop audio capture
     */
    stopCapture() {
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
        this._isListening = false;
        
        state.logActivity('Audio capture stopped', 'info');
    }

    /**
     * Get current audio level (0-1)
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
     * Get frequency data for visualization
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
