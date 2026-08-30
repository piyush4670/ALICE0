/**
 * ALICE Conversation Manager
 * Handles the voice interaction flow
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { audioManager } from './audio.js';
import { wakeWordDetector } from './wakeword.js';
import { stt } from './stt.js';
import { tts } from './tts.js';

class ConversationManager {
    constructor() {
        this._isActive = false;
        this._isListening = false;
        this._conversationHistory = [];
        this._currentTranscript = '';
        this._wakeWordEnabled = true;
        this._autoWakeEnabled = true;
        
        // Callbacks
        this._onWakeWord = null;
        this._onSpeechResult = null;
        this._onAliceSpeak = null;
        
        this._setupCallbacks();
    }

    /**
     * Initialize conversation manager
     */
    async init() {
        // Check availability
        if (!audioManager.isAvailable()) {
            state.logActivity('Voice features unavailable: no microphone support', 'warning');
            return false;
        }

        if (!stt.isAvailable()) {
            state.logActivity('Voice features unavailable: no speech recognition', 'warning');
            return false;
        }

        if (!tts.isAvailable()) {
            state.logActivity('Voice features unavailable: no speech synthesis', 'warning');
            return false;
        }

        // Wait for TTS voices to load
        let attempts = 0;
        while (!tts.isReady() && attempts < 20) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        if (!tts.isReady()) {
            state.logActivity('TTS voices did not load in time', 'warning');
        }

        state.logActivity('Conversation system initialized', 'success');
        return true;
    }

    /**
     * Setup internal callbacks
     */
    _setupCallbacks() {
        // Wake word detection
        wakeWordDetector.onWake(() => {
            this._handleWakeWord();
        });

        // Speech recognition results
        stt.onResult((result) => {
            this._handleSpeechResult(result);
        });

        stt.onError((error) => {
            this._handleSpeechError(error);
        });

        stt.onStart(() => {
            this._isListening = true;
            state.set('aliceState', CONFIG.states.LISTENING);
            state.logActivity('Listening for speech...', 'info');
        });

        stt.onEnd(() => {
            this._isListening = false;
        });

        // TTS callbacks
        tts.onStart(() => {
            state.set('aliceState', CONFIG.states.SPEAKING);
            state.logActivity('ALICE is speaking...', 'info');
        });

        tts.onEnd(() => {
            if (!this._isListening) {
                state.set('aliceState', CONFIG.states.IDLE);
            }
            // Auto-wake after speaking
            if (this._autoWakeEnabled) {
                this._startWakeDetection();
            }
        });

        tts.onError((error) => {
            state.logActivity(`TTS error: ${error}`, 'warning');
            state.set('aliceState', CONFIG.states.IDLE);
        });
    }

    /**
     * Start the conversation system
     */
    async start() {
        if (this._isActive) return;

        const initialized = await this.init();
        if (!initialized) {
            return false;
        }

        this._isActive = true;
        
        // Start wake word detection
        if (this._wakeWordEnabled) {
            await this._startWakeDetection();
        }

        state.logActivity('Voice conversation system active', 'success');
        return true;
    }

    /**
     * Stop the conversation system
     */
    stop() {
        this._isActive = false;
        this._isListening = false;
        
        // Stop all subsystems
        wakeWordDetector.stop();
        stt.stop();
        tts.stop();
        audioManager.stopCapture();
        
        state.set('aliceState', CONFIG.states.IDLE);
        state.logActivity('Voice conversation system stopped', 'info');
    }

    /**
     * Start wake word detection
     */
    async _startWakeDetection() {
        if (!this._wakeWordEnabled || !this._isActive) return;
        
        try {
            await wakeWordDetector.start();
        } catch (error) {
            state.logActivity(`Wake detection error: ${error.message}`, 'warning');
        }
    }

    /**
     * Handle wake word detection
     */
    async _handleWakeWord() {
        // Stop wake detection temporarily
        wakeWordDetector.stop();
        
        // Alert user
        state.set('aliceState', CONFIG.states.LISTENING);
        state.logActivity('Wake word detected!', 'success');
        
        // Callback for UI
        if (this._onWakeWord) {
            this._onWakeWord();
        }

        // Speak acknowledgment
        this._speakAck();

        // Start listening for command
        await this._startListening();
    }

    /**
     * Speak acknowledgment after wake word
     */
    _speakAck() {
        const acks = ['Yes?', 'I\'m listening', 'How can I help?'];
        const ack = acks[Math.floor(Math.random() * acks.length)];
        tts.speak(ack);
    }

    /**
     * Start listening for user speech
     */
    async _startListening() {
        if (this._isListening) return;

        state.set('aliceState', CONFIG.states.LISTENING);
        this._currentTranscript = '';
        
        // Small delay before starting
        await new Promise(r => setTimeout(r, 300));
        
        stt.start();
    }

    /**
     * Handle speech recognition result
     */
    _handleSpeechResult(result) {
        // Update current transcript
        if (result.final) {
            this._currentTranscript = result.final;
        }

        // Callback for UI updates
        if (this._onSpeechResult) {
            this._onSpeechResult({
                text: result.final || result.interim,
                isFinal: result.isComplete,
                interim: result.interim
            });
        }

        // If we have final result, process it
        if (result.isComplete && result.final) {
            this._processCommand(result.final);
        }
    }

    /**
     * Process the recognized command
     */
    _processCommand(text) {
        if (!text || text.trim().length === 0) {
            // No speech detected, go back to wake mode
            state.set('aliceState', CONFIG.states.IDLE);
            if (this._autoWakeEnabled) {
                this._startWakeDetection();
            }
            return;
        }

        // Add to history
        this._addToHistory('user', text);
        
        state.logActivity(`User said: "${text}"`, 'info');
        state.set('aliceState', CONFIG.states.PROCESSING);

        // Generate response
        const response = this._generateResponse(text);
        
        // Speak response
        this._speakResponse(response);
    }

    /**
     * Generate a response (placeholder - Part 3 will connect AI)
     */
    _generateResponse(text) {
        const lower = text.toLowerCase().trim();
        
        // Basic pattern matching for demo
        if (lower.includes('hello') || lower.includes('hi ') || lower.includes('hey')) {
            return 'Hello! How are you doing today?';
        }
        
        if (lower.includes('how are you')) {
            return "I'm doing great, thank you for asking! Ready to help you with anything you need.";
        }
        
        if (lower.includes('what is your name') || lower.includes("what's your name")) {
            return 'My name is ALICE, which stands for Advanced Learning and Intelligence Companion Engine.';
        }
        
        if (lower.includes('capital of japan') || lower.includes('japan capital')) {
            return 'The capital of Japan is Tokyo.';
        }
        
        if (lower.includes('capital of') && lower.includes('france')) {
            return 'The capital of France is Paris.';
        }
        
        if (lower.includes('capital of') && lower.includes('germany')) {
            return 'The capital of Germany is Berlin.';
        }
        
        if (lower.includes('capital of') && lower.includes('india')) {
            return 'The capital of India is New Delhi.';
        }
        
        if (lower.includes('capital of') && lower.includes('australia')) {
            return 'The capital of Australia is Canberra. Note that many people mistakenly think it\'s Sydney, but Canberra is actually the capital.';
        }
        
        if (lower.includes('time')) {
            const now = new Date();
            const hours = now.getHours();
            const minutes = now.getMinutes();
            return `The current time is ${hours} ${minutes < 10 ? 'o\'clock' : minutes}.`;
        }
        
        if (lower.includes('date') || lower.includes('today')) {
            const now = new Date();
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            return `Today's date is ${now.toLocaleDateString('en-US', options)}.`;
        }
        
        if (lower.includes('thank')) {
            return "You're welcome! Is there anything else I can help you with?";
        }
        
        if (lower.includes('bye') || lower.includes('goodbye') || lower.includes('see you')) {
            return "Goodbye! It was great talking with you. Feel free to wake me anytime you need help.";
        }
        
        if (lower.includes('help')) {
            return "I can answer questions, tell you the time, or just chat. Try asking me something like 'what is the capital of France' or just say hello!";
        }
        
        if (lower.includes('who are you') || lower.includes('what are you')) {
            return "I'm ALICE, an AI assistant. I'm here to help you with various tasks, answer questions, and have conversations. What would you like to know?";
        }
        
        if (lower.includes('weather')) {
            return "I don't have access to weather data yet, but I'm working on it! Check back in a future update.";
        }
        
        // Default response
        const defaults = [
            "That's an interesting question. I'm still learning, so I might not have the answer yet.",
            "I understand. I'm not quite sure how to respond to that, but I'm always improving!",
            "Interesting thought! I'm here to help, so feel free to ask me something else."
        ];
        
        return defaults[Math.floor(Math.random() * defaults.length)];
    }

    /**
     * Speak the response
     */
    _speakResponse(text) {
        state.set('aliceState', CONFIG.states.SPEAKING);
        
        // Add to history
        this._addToHistory('alice', text);
        
        state.logActivity(`ALICE: "${text}"`, 'info');
        
        // Callback for UI
        if (this._onAliceSpeak) {
            this._onAliceSpeak(text);
        }
        
        tts.speak(text);
    }

    /**
     * Handle speech recognition error
     */
    _handleSpeechError(error) {
        state.logActivity(`Speech recognition error: ${error}`, 'warning');
        
        if (error === 'no-speech') {
            // No speech detected, go back to wake mode
            state.set('aliceState', CONFIG.states.IDLE);
            if (this._autoWakeEnabled) {
                this._startWakeDetection();
            }
        } else if (error === 'not-allowed') {
            state.logActivity('Microphone access denied. Please enable microphone in browser settings.', 'danger');
            this.stop();
        }
    }

    /**
     * Add entry to conversation history
     */
    _addToHistory(role, text) {
        this._conversationHistory.push({
            role,
            text,
            timestamp: new Date()
        });
        
        // Keep only last 50 entries
        if (this._conversationHistory.length > 50) {
            this._conversationHistory.shift();
        }
    }

    /**
     * Get conversation history
     */
    getHistory() {
        return [...this._conversationHistory];
    }

    /**
     * Clear conversation history
     */
    clearHistory() {
        this._conversationHistory = [];
        state.logActivity('Conversation history cleared', 'info');
    }

    /**
     * Enable/disable wake word detection
     */
    setWakeWordEnabled(enabled) {
        this._wakeWordEnabled = enabled;
        if (!enabled) {
            wakeWordDetector.stop();
        } else if (this._isActive) {
            this._startWakeDetection();
        }
    }

    /**
     * Enable/disable auto-wake after speaking
     */
    setAutoWakeEnabled(enabled) {
        this._autoWakeEnabled = enabled;
    }

    /**
     * Check if system is active
     */
    isActive() {
        return this._isActive;
    }

    /**
     * Check if currently listening
     */
    isListening() {
        return this._isListening;
    }

    /**
     * Set wake word callback
     */
    onWakeWord(callback) {
        this._onWakeWord = callback;
    }

    /**
     * Set speech result callback
     */
    onSpeechResult(callback) {
        this._onSpeechResult = callback;
    }

    /**
     * Set Alice speak callback
     */
    onAliceSpeak(callback) {
        this._onAliceSpeak = callback;
    }

    /**
     * Manually trigger wake word (for testing/button)
     */
    triggerWakeWord() {
        this._handleWakeWord();
    }

    /**
     * Stop current speech
     */
    stopSpeaking() {
        tts.stop();
        state.set('aliceState', CONFIG.states.IDLE);
        if (this._autoWakeEnabled) {
            this._startWakeDetection();
        }
    }
}

// Singleton instance
export const conversation = new ConversationManager();
