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
        this._lang = 'en-US';
        this._sessionCounter = 0;
        this._currentSession = null;

        this._initRecognition();
    }

    /**
     * Create and configure a SpeechRecognition instance.
     */
    _createRecognitionInstance() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            return null;
        }
        const recognition = new SpeechRecognition();
        recognition.continuous = this._continuousMode;
        recognition.interimResults = this._interimResults;
        recognition.lang = this._lang;
        recognition.maxAlternatives = 1;
        recognition._hasStarted = false;
        return recognition;
    }

    /**
     * Initialize Web Speech Recognition
     */
    _initRecognition() {
        const recognition = this._createRecognitionInstance();
        if (!recognition) {
            state.logActivity('Speech Recognition not supported in this browser', 'warning');
            return;
        }

        this._recognition = recognition;
        this._bindRecognitionSession(recognition, null);
    }

    /**
     * Bind event handlers on a recognition instance to a specific session
     * snapshot so delayed events from an older session never read metadata
     * belonging to a newer session.
     */
    _bindRecognitionSession(recognition, session) {
        recognition.onstart = () => {
            const boundSession = session || this._currentSession;
            if (!boundSession || (this._currentSession === boundSession && !boundSession.stopped)) {
                this._isListening = true;
                this._sessionActive = true;
                state.logActivity('Speech recognition started', 'success');
                if (this._onStart) this._onStart();
            }
        };

        recognition.onresult = (event) => {
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
                const boundSession = session || this._currentSession;
                const sessionContext = boundSession ? boundSession.context : null;
                const isCurrentSession = Boolean(
                    boundSession &&
                    this._currentSession === boundSession &&
                    !boundSession.stopped &&
                    !boundSession.ended
                );
                this._onResult({
                    final: finalTranscript.trim(),
                    interim: interimTranscript.trim(),
                    results,
                    isComplete: finalTranscript.length > 0,
                    sessionId: boundSession ? boundSession.id : null,
                    sessionContext,
                    confirmationPromptId: sessionContext?.confirmationPromptId ?? null,
                    isCurrentSession
                });
            }
        };

        recognition.onerror = (event) => {
            state.logActivity(`Speech recognition error: ${event.error}`, 'warning');
            
            if (event.error === 'not-allowed') {
                state.logActivity('Microphone access denied', 'danger');
            }
            
            const boundSession = session || this._currentSession;
            if (!boundSession || this._currentSession === boundSession) {
                if (this._onError) {
                    this._onError(event.error);
                }
                this._isListening = false;
            }
        };

        recognition.onend = () => {
            const boundSession = session || this._currentSession;
            if (boundSession) {
                boundSession.ended = true;
            }
            if (!boundSession || this._currentSession === boundSession) {
                this._isListening = false;
                this._sessionActive = false;
                state.logActivity('Speech recognition ended', 'info');

                if (this._onEnd) {
                    this._onEnd();
                }
            }
        };
    }

    /**
     * Check if STT is available
     */
    isAvailable() {
        if (!this._recognition && (window.SpeechRecognition || window.webkitSpeechRecognition)) {
            this._initRecognition();
        }
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
        this._lang = lang;
        if (this._recognition) {
            this._recognition.lang = lang;
        }
    }

    /**
     * Return the metadata bound to the current or most recent session.
     */
    getSessionContext() {
        return this._currentSession ? this._currentSession.context : null;
    }

    /**
     * Check if the current session has been asked to stop but its
     * asynchronous `onend` event has not fired yet.
     */
    isStopping() {
        return Boolean(this._currentSession && this._currentSession.stopped && !this._currentSession.ended);
    }

    /**
     * Check if a confirmation prompt ID is currently bound to an active,
     * non-stopping STT session.
     */
    isBoundToConfirmation(promptId) {
        if (typeof promptId !== 'number' || !Number.isInteger(promptId) || promptId <= 0) {
            return false;
        }
        return Boolean(
            (this._isListening || this._sessionActive) &&
            this._currentSession &&
            !this._currentSession.stopped &&
            !this._currentSession.ended &&
            this._currentSession.context &&
            this._currentSession.context.isConfirmation === true &&
            this._currentSession.context.confirmationPromptId === promptId
        );
    }

    /**
     * Start listening. Optional `sessionContext` is frozen and bound to this
     * specific recognition session so late events from an older session can
     * never inherit a newer session's context.
     */
    start(sessionContext = null) {
        if (!this._recognition && (window.SpeechRecognition || window.webkitSpeechRecognition)) {
            this._initRecognition();
        }
        if (!this._recognition) {
            state.logActivity('Cannot start: Speech Recognition not available', 'danger');
            return false;
        }

        // Guard on the full session window (start requested → onend), not
        // just on `_isListening`, so we never double-start a session.
        if (this._sessionActive || this._isListening || this.isStopping()) {
            return false;
        }

        // If the current recognition instance has already been used for an
        // earlier session, create a fresh instance so delayed events on the
        // old instance remain isolated to that older session's closure.
        if (this._recognition._hasStarted) {
            const fresh = this._createRecognitionInstance();
            if (fresh) {
                this._recognition = fresh;
            }
        }

        const frozenContext = (sessionContext && typeof sessionContext === 'object')
            ? Object.freeze({ ...sessionContext })
            : null;
        const session = {
            id: ++this._sessionCounter,
            context: frozenContext,
            stopped: false,
            ended: false
        };

        try {
            this._currentSession = session;
            this._sessionActive = true;
            this._recognition._hasStarted = true;
            this._bindRecognitionSession(this._recognition, session);
            this._recognition.start();
            return true;
        } catch (error) {
            session.stopped = true;
            session.ended = true;
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

        const wasListening = this._isListening;
        if (this._currentSession) {
            this._currentSession.stopped = true;
        }

        try {
            this._recognition.stop();
        } catch (error) {
            if (this._currentSession) {
                this._currentSession.ended = true;
            }
            this._sessionActive = false;
            this._isListening = false;
            return;
        }

        // If recognition had not even started capturing audio yet (`onstart`
        // never fired), stop() may not emit `onend`; clear state immediately.
        // If it WAS live (`wasListening`), `onend` clears `_sessionActive` and
        // `_isListening` when teardown completes (which may be synchronous or
        // asynchronous).
        if (!wasListening && (!this._currentSession || !this._currentSession.ended)) {
            if (this._currentSession) {
                this._currentSession.ended = true;
            }
            this._sessionActive = false;
            this._isListening = false;
        }
    }

    /**
     * Abort recognition
     */
    abort() {
        if (!this._recognition) return;

        if (this._currentSession) {
            this._currentSession.stopped = true;
            this._currentSession.ended = true;
        }

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
