/**
 * ALICE Conversation Manager
 * Handles the voice interaction flow with skill integration
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { audioManager } from './audio.js';
import { wakeWordDetector } from './wakeword.js';
import { stt } from './stt.js';
import { tts } from './tts.js';
import { skillManager } from './skillManager.js';
import { memory } from './memory.js';
import { agent } from './agent.js';
import { permissions } from './permissions.js';

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

        // Confirmation listening (Part 4)
        this._confirmationActive = false;
        
        this._setupCallbacks();
        this._setupPermissionCallbacks();
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
        state.logActivity(`Skills loaded: ${skillManager.getSkills().map(s => s.name).join(', ')}`, 'info');
        
        return true;
    }

    /**
     * Wire up the permission system: when a confirmation prompt opens,
     * speak the prompt and prepare to listen for the user's answer.
     */
    _setupPermissionCallbacks() {
        permissions.onPrompt((meta) => {
            this._confirmationActive = true;
            const prompt = `${meta.title}. ${meta.message} Say "approve" to continue, or "cancel" to stop.`;
            this._speakResponse(prompt, 'confirmation');
        });

        permissions.onResolved(() => {
            this._confirmationActive = false;
            if (this._isListening) {
                stt.stop();
            }
        });
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
            // If a confirmation is pending, listen for "approve"/"cancel"
            if (this._confirmationActive) {
                this._startListening();
                return;
            }
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
        const acks = ['Yes?', 'I\'m listening', 'How can I help?', 'Ready.'];
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
            // If we're awaiting a confirmation answer, route the speech there
            if (this._confirmationActive) {
                this._handleConfirmationSpeech(result.final);
                return;
            }
            this._processCommand(result.final);
        }
    }

    /**
     * Route recognized speech while a confirmation is pending.
     * Only "approve"/"cancel" answers are accepted; anything else re-prompts.
     */
    _handleConfirmationSpeech(text) {
        const handled = permissions.answerVoice(text);
        if (handled === null) {
            this._speakResponse('Please say "approve" or "cancel".', 'confirmation');
            this._startListening();
        }
        // else: permissions.onResolved already fired and stopped listening
    }

    /**
     * Process the recognized command
     */
    async _processCommand(text) {
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
        state.addToConversation('user', text);
        
        state.logActivity(`User said: "${text}"`, 'info');
        state.set('aliceState', CONFIG.states.PROCESSING);

        // Process through skill system
        const result = await this._processWithSkills(text);
        
        // Speak response
        this._speakResponse(result.response, result.skill);
    }

    /**
     * Public entry point for text-based commands (used by the HUD command
     * input and debug/demo triggers). Routes through the same pipeline as
     * voice commands.
     */
    processText(text) {
        if (!text || !text.trim()) return;
        this._processCommand(text.trim());
    }

    /**
     * Process command through skill system
     */
    async _processWithSkills(text) {
        state.set('aliceState', CONFIG.states.UNDERSTANDING);
        
        // Try the agent first for multi-step goals (Part 4).
        // The agent returns null when the input is not a multi-step task,
        // in which case we fall back to the single-skill path unchanged.
        const agentResult = await agent.process(text, {
            speak: (t) => this._speakResponse(t, 'agent')
        });

        if (agentResult) {
            state.set('aliceState', CONFIG.states.COMPLETING);
            return { response: agentResult.response, skill: 'agent' };
        }

        // Single-skill path. Permission enforcement is centralized: the
        // gateway runs inside skillManager.executeByName() immediately
        // before the skill executes, so this path cannot bypass (or
        // duplicate) the confirmation flow.
        const match = skillManager.matchSkill(text);

        if (match.skill) {
            const skillResult = await skillManager.executeByName(match.skill.name, text, {});

            if (skillResult.success) {
                state.setSkillState(match.skill.name, skillResult);
                
                // Handle interactive results
                if (skillResult.interactive) {
                    return { response: skillResult.result, skill: 'interaction' };
                }
                
                return { response: skillResult.result, skill: match.skill.name };
            }
            
            // A permission denial (user cancelled the confirmation) is
            // reported as a cancelled action — nothing was executed.
            if (skillResult.permission && skillResult.permission.decision === 'denied') {
                return { response: skillResult.error, skill: 'confirmation' };
            }

            return { response: skillResult.error || 'Something went wrong.', skill: match.skill.name };
        }
        
        // Fall back to basic responses
        const basicResponse = this._generateBasicResponse(text);
        return { response: basicResponse, skill: 'basic' };
    }

    /**
     * Generate basic responses (fallback when no skill matches)
     */
    _generateBasicResponse(text) {
        const lower = text.toLowerCase().trim();
        
        // Basic pattern matching
        if (lower.includes('hello') || lower.includes('hi ') || lower.includes('hey')) {
            return 'Hello! How are you doing today?';
        }
        
        if (lower.includes('how are you')) {
            return "I'm doing great, thank you for asking! Ready to help you with anything you need.";
        }
        
        if (lower.includes('what is your name') || lower.includes("what's your name")) {
            return 'My name is ALICE, which stands for Advanced Learning and Intelligence Companion Engine.';
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
            return "I can help you with many things! Try saying 'calculate 25 percent of 800', 'remind me to call mom at 6 PM', 'remember that my favorite color is blue', or 'search the web for weather'. What would you like to do?";
        }
        
        if (lower.includes('who are you') || lower.includes('what are you')) {
            return "I'm ALICE, an AI assistant with skills in calculations, reminders, notes, web search, and memory. Just say 'help' to learn more about what I can do!";
        }
        
        // Default response
        const defaults = [
            "That's interesting! I'm not sure how to help with that specifically, but try saying 'help' to learn about my skills.",
            "I understand. I'm here to help with calculations, reminders, notes, web search, and remembering things. What would you like assistance with?",
            "I'm here to help! Try asking me to calculate something, set a reminder, save a note, or search the web."
        ];
        
        return defaults[Math.floor(Math.random() * defaults.length)];
    }

    /**
     * Speak the response
     */
    _speakResponse(text, skill = null) {
        state.set('aliceState', CONFIG.states.SPEAKING);
        
        // Add to history
        this._addToHistory('alice', text);
        state.addToConversation('alice', text);
        state.setLastResponse(text);
        
        const logMsg = skill ? `ALICE (${skill}): "${text}"` : `ALICE: "${text}"`;
        state.logActivity(logMsg, 'info');
        
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

    /**
     * Get skill manager for external access
     */
    getSkillManager() {
        return skillManager;
    }
}

// Singleton instance
export const conversation = new ConversationManager();
