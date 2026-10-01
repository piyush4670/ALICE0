/**
 * ALICE Conversation Manager
 * Handles the voice interaction flow with skill integration
 *
 * Stage 1A: this module is the SINGLE OWNER of the voice lifecycle
 * (OFF / READY / LISTENING / PROCESSING / SPEAKING / STOPPING / ERROR).
 * STT, TTS and wake detection only report events here; state is updated
 * here; the HUD only renders it. A generation token invalidates stale
 * async callbacks so an explicit Stop can never be undone by a late
 * event, and voice can never auto-restart after the user disabled it.
 */
import { CONFIG } from './config.js';
import { state } from './state.js';
import { VOICE_STATUS } from './voiceStatus.js';
import { audioManager } from './audio.js';
import { wakeWordDetector } from './wakeword.js';
import { stt } from './stt.js';
import { tts } from './tts.js';
import { skillManager } from './skillManager.js';
import { memory } from './memory.js';
import { agent } from './agent.js';
import { permissions } from './permissions.js';
import { aiBrain } from './ai/aiBrain.js';
import { createInteractionContext } from './ai/interactionContext.js';
import { detectIntent } from './ai/intentDetector.js';
import { detectResponseDepth } from './ai/responseDepthDetector.js';
import { detectPersonalityMode } from './ai/personalityModeDetector.js';
import { detectEmotionalSignal } from './ai/emotionalSignalDetector.js';
import { delay } from './utils.js';

class ConversationManager {
    constructor() {
        this._isActive = false;
        this._isListening = false;
        this._conversationHistory = [];
        this._currentTranscript = '';
        this._wakeWordEnabled = true;
        this._autoWakeEnabled = true;

        // Stage 1A lifecycle control
        // -------------------------
        // User pressed STOP (or voice is otherwise intentionally quiet).
        // Suppresses every automatic restart path until the next explicit
        // interaction (manual wake, voice command, or text command).
        this._stopped = false;
        // Monotonic generation counter. Bumped on every enable/disable/stop;
        // async callbacks capture it and abort if it changed meanwhile.
        this._generation = 0;
        // Generation at which the current listening session was started,
        // used to drop results from sessions invalidated by Stop.
        this._listenToken = -1;
        // True while a listening session is being set up (inside the
        // pre-listen delay). Wake detection refuses to start during this
        // window so it can never fight the upcoming STT session.
        this._listenPending = false;

        // Callbacks
        this._onWakeWord = null;
        this._onSpeechResult = null;
        this._onAliceSpeak = null;

        // Confirmation listening (Part 4)
        this._confirmationActive = false;
        this._confirmationPromptId = null;
        this._listeningConfirmationId = null;
        this._pendingListenPromptId = null;
        this._pendingConfirmationRestartId = null;
        this._listenEpoch = 0;
        this._pendingListenEpoch = -1;
        this._activeListenEpoch = -1;

        // Part 7A: minimal deterministic turn lifecycle
        // Whether a previous completed user/ALICE interaction exists.
        // First command => 'new', subsequent => 'follow_up'. Reset by clearHistory().
        this._hasHadInteraction = false;

        this._setupCallbacks();
        this._setupPermissionCallbacks();
    }

    // ==================================================================
    // Lifecycle helpers (Stage 1A)
    // ==================================================================

    _setStatus(status, detail = '') {
        state.setVoiceStatus(status, detail);
    }

    _bumpGeneration() {
        this._generation += 1;
        this._listenEpoch += 1;
        this._pendingListenEpoch = -1;
        this._pendingListenPromptId = null;
        this._pendingConfirmationRestartId = null;
        return this._generation;
    }

    /**
     * Tear down all voice subsystems without changing the enabled flag.
     */
    _shutdownSubsystems() {
        wakeWordDetector.stop();
        stt.stop();
        tts.stop();
        audioManager.stopCapture();
        this._isListening = false;
        this._listenPending = false;
        this._listeningConfirmationId = null;
        this._pendingListenPromptId = null;
        this._pendingConfirmationRestartId = null;
        state.setVoiceState('isListening', false);
        state.setVoiceState('isWakeDetectionRunning', false);
    }

    /**
     * Only clear aliceStates that the voice layer itself owns. Agent /
     * planner / permission states (EXECUTING, PLANNING, WAITING, ...) are
     * left untouched.
     */
    _clearVoiceOwnedAliceState() {
        const alice = state.get('aliceState');
        if (alice === CONFIG.states.LISTENING || alice === CONFIG.states.SPEAKING) {
            state.set('aliceState', CONFIG.states.IDLE);
        }
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
            const promptId = (meta && typeof meta.id === 'number' && Number.isInteger(meta.id) && meta.id > 0)
                ? meta.id
                : null;
            this._confirmationActive = true;
            this._confirmationPromptId = promptId;
            this._listeningConfirmationId = null;
            this._pendingListenPromptId = null;
            this._pendingConfirmationRestartId = null;
            this._listenEpoch += 1;
            this._pendingListenEpoch = -1;
            if (this._isListening || stt.isListening() || stt.hasActiveSession()) {
                stt.stop();
            }
            const prompt = `${meta.title}. ${meta.message} Say "approve" to continue, or "cancel" to stop.`;
            this._speakResponse(prompt, 'confirmation');
        });

        permissions.onResolved((info) => {
            const resolvedId = info?.meta?.id;
            if (resolvedId === undefined || this._confirmationPromptId === null || resolvedId === this._confirmationPromptId) {
                this._confirmationActive = false;
                this._confirmationPromptId = null;
            }
            if (resolvedId === undefined || this._listeningConfirmationId === resolvedId) {
                this._listeningConfirmationId = null;
            }
            if (resolvedId === undefined || this._pendingListenPromptId === resolvedId) {
                this._pendingListenPromptId = null;
            }
            if (resolvedId === undefined || this._pendingConfirmationRestartId === resolvedId) {
                this._pendingConfirmationRestartId = null;
            }
            this._listenEpoch += 1;
            this._pendingListenEpoch = -1;
            if (this._isListening || stt.isListening() || stt.hasActiveSession()) {
                stt.stop();
            }
            // Once the answer has been processed, resume wake detection if
            // voice is still enabled and was not explicitly stopped. The
            // short wait lets the STT session end first (guards inside
            // _startWakeDetection refuse to fight a live session), and the
            // token check makes sure a Stop pressed meanwhile wins.
            const token = this._generation;
            setTimeout(() => {
                if (token === this._generation && !this._confirmationActive && !permissions.hasPending()) {
                    this._startWakeDetection();
                }
            }, 200);
        });
    }

    /**
     * Setup internal callbacks
     */
    _setupCallbacks() {
        // Wake word detection
        wakeWordDetector.onWake(() => {
            this._handleWakeWord('audio');
        });

        // Speech recognition results
        stt.onResult((result) => {
            this._handleSpeechResult(result);
        });

        stt.onError((error) => {
            this._handleSpeechError(error);
        });

        stt.onStart(() => {
            // STT is REALLY capturing audio now — only at this point may the
            // UI say "Listening" (Stage 1A sync guarantee).
            this._listenPending = false;
            this._isListening = true;
            state.setVoiceState('isListening', true);
            this._setStatus(VOICE_STATUS.LISTENING);
            state.set('aliceState', CONFIG.states.LISTENING);
            state.logActivity('Listening for speech...', 'info');
        });

        stt.onEnd(() => {
            const hasInFlightListenSetup = this._listenPending && this._pendingListenEpoch === this._listenEpoch;
            if (!hasInFlightListenSetup) {
                this._listenPending = false;
                this._pendingListenPromptId = null;
            }
            this._isListening = false;
            this._listeningConfirmationId = null;
            state.setVoiceState('isListening', false);
            if (!this._isActive) return;
            // Drop back to READY only if we still own the lifecycle status.
            // An explicit Stop has already moved us on (STOPPING → READY).
            if (state.getVoiceState().status === VOICE_STATUS.LISTENING) {
                this._setStatus(VOICE_STATUS.READY);
                this._clearVoiceOwnedAliceState();
            }

            // If a confirmation prompt finished speaking while the previous
            // STT session was still shutting down (waiting for this async
            // `onend` callback), start the confirmation's bound listener now.
            if (
                !this._stopped &&
                this._confirmationActive &&
                this._confirmationPromptId !== null &&
                permissions.hasPending() &&
                permissions.getPendingMeta()?.id === this._confirmationPromptId &&
                this._pendingConfirmationRestartId === this._confirmationPromptId &&
                !hasInFlightListenSetup &&
                !tts.isSpeaking()
            ) {
                const targetPromptId = this._confirmationPromptId;
                this._pendingConfirmationRestartId = null;
                this._startListening(targetPromptId);
            }
        });

        // TTS callbacks
        tts.onStart(() => {
            // Listening (mic live) takes precedence over the speaking
            // indicator: after wake, ALICE plays a short acknowledgment
            // while the STT session is already (or about to be) live.
            if (state.getVoiceState().status !== VOICE_STATUS.LISTENING && !this._listenPending) {
                this._setStatus(VOICE_STATUS.SPEAKING);
            }
            if (state.get('aliceState') !== CONFIG.states.LISTENING) {
                state.set('aliceState', CONFIG.states.SPEAKING);
            }
            state.logActivity('ALICE is speaking...', 'info');
        });

        tts.onEnd((info) => {
            // An explicit stop (Stop button / voice disable / superseding
            // utterance) owns the state transition — never auto-restart
            // anything from a cancelled utterance (Stage 1A race fix).
            if (info && info.cancelled) return;
            if (state.getVoiceState().status === VOICE_STATUS.STOPPING) return;

            // If a confirmation is pending, listen for "approve"/"cancel"
            if (this._confirmationActive) {
                this._startListening(this._confirmationPromptId);
                return;
            }

            // The microphone owns the interaction state: an utterance that
            // finishes while STT is live (e.g. the wake acknowledgment) or
            // while a listening session is being set up must not reset the
            // status or re-arm wake detection (Stage 1A race fix).
            if (this._isListening || stt.hasActiveSession() || this._listenPending) return;

            if (state.getVoiceState().status === VOICE_STATUS.SPEAKING) {
                this._setStatus(this._isActive ? VOICE_STATUS.READY : VOICE_STATUS.OFF);
                this._clearVoiceOwnedAliceState();
            }

            // Auto-wake after speaking — only when voice is enabled AND the
            // user has not explicitly stopped it (Stage 1A race fix).
            if (this._isActive && this._autoWakeEnabled) {
                this._startWakeDetection();
            }
        });

        tts.onError((error) => {
            state.logActivity(`TTS error: ${error}`, 'warning');
            if (state.getVoiceState().status === VOICE_STATUS.SPEAKING) {
                this._setStatus(this._isActive ? VOICE_STATUS.READY : VOICE_STATUS.OFF);
                this._clearVoiceOwnedAliceState();
            }
        });
    }

    // ==================================================================
    // Public lifecycle API (Stage 1A)
    // ==================================================================

    /**
     * User-facing entry point for enabling voice (Mic button). The
     * ConversationManager owns EVERY lifecycle transition here:
     * permission → start → READY, or ERROR when unavailable. App/UI code
     * only requests this action and renders the resulting state.
     * Returns { started, permission, aborted? }.
     */
    async enableVoice() {
        state.setVoiceState('isMicrophoneAvailable', audioManager.isAvailable());

        if (this._isActive) {
            return { started: true, permission: true };
        }

        const token = this._generation;
        const hasPermission = await audioManager.requestPermission();
        state.setVoiceState('isMicrophonePermission', hasPermission);

        if (!hasPermission) {
            this._setStatus(VOICE_STATUS.ERROR, 'Voice unavailable — microphone access denied');
            state.logActivity('Microphone access denied — voice disabled; text input still works', 'warning');
            return { started: false, permission: false };
        }

        // Stop/disable happened while the permission prompt was open —
        // never resurrect voice from a stale enable flow (Stage 1A).
        if (token !== this._generation) {
            state.logActivity('Voice enable aborted — stopped during permission request', 'info');
            return { started: false, permission: true, aborted: true };
        }

        const started = await this.start();
        if (!started) {
            this._setStatus(VOICE_STATUS.ERROR, 'Voice unavailable');
            state.logActivity('Voice system could not start (missing browser support?)', 'warning');
            return { started: false, permission: true };
        }

        return { started: true, permission: true };
    }

    /**
     * Called when the HUD opens after boot: voice is OFF until the user
     * explicitly enables the microphone. Only the ConversationManager
     * transitions the lifecycle (Stage 1A authority).
     */
    syncBootState() {
        state.setVoiceState('isMicrophoneAvailable', audioManager.isAvailable());
        if (!this._isActive) {
            this._setStatus(VOICE_STATUS.OFF);
        }
    }

    /**
     * Start the conversation system (user explicitly enabled voice).
     */
    async start() {
        if (this._isActive) return true;

        const initialized = await this.init();
        if (!initialized) {
            return false;
        }

        this._bumpGeneration();
        this._isActive = true;
        this._stopped = false;
        state.setVoiceState('isActive', true);
        this._setStatus(VOICE_STATUS.READY);

        // Start wake word detection
        if (this._wakeWordEnabled) {
            await this._startWakeDetection();
        }

        state.logActivity('Voice conversation system active', 'success');
        return true;
    }

    /**
     * Stop the conversation system entirely (voice OFF). Microphone
     * capture, STT, TTS and wake detection are all released; nothing can
     * auto-restart afterwards until the user enables voice again.
     */
    stop() {
        this._bumpGeneration();
        this._isActive = false;
        this._stopped = false;
        this._confirmationActive = false;
        this._confirmationPromptId = null;
        this._listeningConfirmationId = null;

        this._shutdownSubsystems();

        state.setVoiceState('isActive', false);
        this._clearVoiceOwnedAliceState();
        this._setStatus(VOICE_STATUS.OFF);
        state.logActivity('Voice conversation system stopped', 'info');
    }

    /**
     * Stop button (Stage 1A fix): interrupt whatever voice is doing right
     * now — listening, speaking, or wake detection — and return to a valid
     * idle state. Voice stays enabled (if it was), but nothing restarts
     * automatically until the user interacts again.
     */
    stopAllActivity() {
        this._bumpGeneration();
        this._stopped = true;
        this._confirmationActive = false;
        this._confirmationPromptId = null;
        this._listeningConfirmationId = null;

        this._setStatus(VOICE_STATUS.STOPPING);
        const wasDoingSomething =
            stt.isListening() || stt.hasActiveSession() ||
            tts.isSpeaking() || wakeWordDetector.isRunning();

        this._shutdownSubsystems();
        this._clearVoiceOwnedAliceState();

        if (this._isActive) {
            this._setStatus(VOICE_STATUS.READY, wasDoingSomething ? 'Stopped by user' : '');
        } else {
            this._setStatus(VOICE_STATUS.OFF);
        }

        state.logActivity('Voice activity stopped by user', 'info');
    }

    /**
     * Start wake word detection. Refuses to run when voice is disabled,
     * explicitly stopped, or when it would fight a live STT/TTS session.
     */
    async _startWakeDetection() {
        if (!this._isActive || !this._wakeWordEnabled) return false;
        if (this._stopped) return false;
        // Never fight STT or TTS (Stage 1A).
        if (this._isListening || this._listenPending || stt.hasActiveSession()) return false;
        if (tts.isSpeaking()) return false;
        if (wakeWordDetector.isRunning()) return true;

        const token = this._generation;
        try {
            const started = await wakeWordDetector.start();
            // Stop/disable raced the async microphone capture.
            if (token !== this._generation) {
                wakeWordDetector.stop();
                state.setVoiceState('isWakeDetectionRunning', false);
                return false;
            }
            state.setVoiceState('isWakeDetectionRunning', !!started);
            return !!started;
        } catch (error) {
            state.logActivity(`Wake detection error: ${error.message}`, 'warning');
            state.setVoiceState('isWakeDetectionRunning', false);
            return false;
        }
    }

    /**
     * Handle wake word detection
     */
    async _handleWakeWord(source = 'audio') {
        if (!this._isActive) return;

        // Stop wake detection temporarily
        wakeWordDetector.stop();
        state.setVoiceState('isWakeDetectionRunning', false);
        this._stopped = false; // an explicit interaction is starting

        state.logActivity(
            source === 'manual' ? 'Wake triggered manually' : 'Wake triggered (voice activity detected)',
            'success'
        );

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
     * Check whether the given confirmation prompt ID is bound to the active,
     * non-stopping STT session.
     */
    _isConfirmationBoundToActiveSession(promptId) {
        if (typeof promptId !== 'number' || !Number.isInteger(promptId) || promptId <= 0) {
            return false;
        }
        return Boolean(
            this._isListening &&
            this._listeningConfirmationId === promptId &&
            !stt.isStopping() &&
            stt.isBoundToConfirmation(promptId)
        );
    }

    /**
     * Start listening for user speech. The actual LISTENING status is only
     * set by the STT onStart event — never optimistically (Stage 1A).
     * While the session is being set up, `_listenPending` tells TTS-end and
     * wake-detection handlers to stay out of the way.
     */
    async _startListening(confirmationPromptId = undefined) {
        if (!this._isActive) return false;

        // Capture the exact confirmation state and prompt ID that were active
        // when this listening session was requested — never read a newer
        // prompt ID after the pre-listen delay or when a result arrives.
        const isConfirmationListen = this._confirmationActive || confirmationPromptId !== undefined;
        const boundPromptId = isConfirmationListen
            ? (confirmationPromptId !== undefined ? confirmationPromptId : this._confirmationPromptId)
            : null;

        if (isConfirmationListen) {
            if (!this._confirmationActive || boundPromptId === null || this._confirmationPromptId !== boundPromptId) {
                return false;
            }
            // Only report success if the active, non-stopping STT session is
            // already bound to this exact confirmation prompt ID.
            if (this._isConfirmationBoundToActiveSession(boundPromptId)) {
                this._pendingConfirmationRestartId = null;
                return true;
            }
            // Avoid starting duplicate setups for the same confirmation prompt.
            if (
                this._listenPending &&
                this._pendingListenEpoch === this._listenEpoch &&
                this._pendingListenPromptId === boundPromptId
            ) {
                return false;
            }
            // If a previous session is still live or waiting for its async
            // `onend` teardown, stop it (if not already stopping) and record
            // the pending confirmation prompt ID before the delay so `stt.onEnd`
            // knows which confirmation needs a bound listener.
            if (this._isListening || stt.isListening() || stt.hasActiveSession()) {
                this._pendingConfirmationRestartId = boundPromptId;
                if (!stt.isStopping()) {
                    stt.stop();
                }
            }
        } else {
            if (this._isListening && !stt.isStopping() && stt.hasActiveSession() && this._listeningConfirmationId === null) {
                return true;
            }
            if (
                this._listenPending &&
                this._pendingListenEpoch === this._listenEpoch &&
                this._pendingListenPromptId === null
            ) {
                return false;
            }
        }

        this._listenPending = true;
        this._pendingListenPromptId = isConfirmationListen ? boundPromptId : null;
        this._currentTranscript = '';
        state.clearTranscript();

        const token = this._generation;
        const epoch = ++this._listenEpoch;
        this._pendingListenEpoch = epoch;

        // Small delay before starting
        await delay(300);

        // Stop/disable, stopListening(), or a confirmation prompt change
        // occurred during the delay — do not start STT or rebind.
        if (token !== this._generation || epoch !== this._listenEpoch) {
            if (this._pendingListenEpoch === epoch) {
                this._listenPending = false;
                this._pendingListenPromptId = null;
            }
            return false;
        }
        if (isConfirmationListen) {
            if (
                !this._confirmationActive ||
                boundPromptId === null ||
                this._confirmationPromptId !== boundPromptId ||
                !permissions.hasPending() ||
                permissions.getPendingMeta()?.id !== boundPromptId
            ) {
                this._listenPending = false;
                this._pendingListenPromptId = null;
                if (this._pendingConfirmationRestartId === boundPromptId) {
                    this._pendingConfirmationRestartId = null;
                }
                return false;
            }
            if (this._isConfirmationBoundToActiveSession(boundPromptId)) {
                this._listenPending = false;
                this._pendingListenPromptId = null;
                this._pendingConfirmationRestartId = null;
                return true;
            }
            // Previous STT session is still active or waiting for its delayed
            // `onend` callback — never report success prematurely. Queue this
            // prompt ID so `stt.onEnd` starts the bound confirmation listener
            // as soon as teardown completes.
            if (this._isListening || stt.isListening() || stt.hasActiveSession() || stt.isStopping()) {
                this._listenPending = false;
                this._pendingListenPromptId = null;
                this._pendingConfirmationRestartId = boundPromptId;
                if (!stt.isStopping()) {
                    stt.stop();
                }
                return false;
            }
        } else {
            if (this._confirmationActive) {
                this._listenPending = false;
                this._pendingListenPromptId = null;
                return false;
            }
            if (this._isListening && !stt.isStopping() && stt.hasActiveSession() && this._listeningConfirmationId === null) {
                this._listenPending = false;
                this._pendingListenPromptId = null;
                return true;
            }
            if (this._isListening || stt.isListening() || stt.hasActiveSession() || stt.isStopping()) {
                this._listenPending = false;
                this._pendingListenPromptId = null;
                return false;
            }
        }

        const started = stt.start({
            generation: token,
            listenEpoch: epoch,
            isConfirmation: isConfirmationListen,
            confirmationPromptId: boundPromptId
        });
        const boundOk = started && (
            !isConfirmationListen ||
            (stt.isBoundToConfirmation(boundPromptId) && !stt.isStopping())
        );

        if (boundOk) {
            this._listenToken = this._generation;
            this._activeListenEpoch = epoch;
            this._listeningConfirmationId = isConfirmationListen ? boundPromptId : null;
            this._pendingListenPromptId = null;
            if (isConfirmationListen && this._pendingConfirmationRestartId === boundPromptId) {
                this._pendingConfirmationRestartId = null;
            }
            // stt.onStart clears _listenPending once the session is live
            // (it also fires synchronously on some platforms).
            this._listenPending = !stt.isListening();
            return true;
        }

        this._listenPending = false;
        this._pendingListenPromptId = null;
        this._listeningConfirmationId = null;
        if (started) {
            stt.stop();
        }
        if (isConfirmationListen) {
            state.logActivity(
                'Could not start voice confirmation listener — prompt remains pending (retry voice or use the Approve / Cancel buttons)',
                'warning'
            );
        } else {
            state.logActivity('Could not start speech recognition', 'warning');
        }
        return false;
    }

    /**
     * Explicitly retry starting the voice listener for the currently pending
     * confirmation prompt when an earlier start attempt could not complete.
     * Never auto-approves; if voice cannot start, the prompt stays pending
     * for another retry or manual Approve/Cancel button interaction.
     */
    async retryConfirmationListening() {
        const pendingMeta = permissions.getPendingMeta();
        if (!pendingMeta || typeof pendingMeta.id !== 'number') {
            return false;
        }
        this._confirmationActive = true;
        this._confirmationPromptId = pendingMeta.id;
        return this._startListening(pendingMeta.id);
    }

    /**
     * Stop listening explicitly (ends the STT session; status reconciles
     * via the STT onEnd event).
     */
    stopListening() {
        this._listenEpoch += 1;
        this._pendingListenEpoch = -1;
        this._listeningConfirmationId = null;
        this._pendingListenPromptId = null;
        this._pendingConfirmationRestartId = null;
        this._listenPending = false;
        if (this._isListening || stt.hasActiveSession()) {
            stt.stop();
        }
    }

    /**
     * Handle speech recognition result
     */
    _handleSpeechResult(result) {
        // Drop results from sessions invalidated by Stop/disable (Stage 1A).
        if (this._listenToken !== this._generation) return;
        if (result?.sessionContext?.generation !== undefined && result.sessionContext.generation !== this._generation) {
            return;
        }

        const hasSessionContext = Boolean(result && result.sessionContext && typeof result.sessionContext === 'object');
        const hasExplicitPromptId = Boolean(result && Object.prototype.hasOwnProperty.call(result, 'confirmationPromptId'));
        const isConfirmationResult = hasSessionContext
            ? Boolean(result.sessionContext.isConfirmation)
            : (hasExplicitPromptId ? result.confirmationPromptId !== null : this._confirmationActive);

        // Determine the prompt ID bound when the originating listening session
        // began. Never read this._confirmationPromptId (the latest prompt ID)
        // here, as that would rebind speech from an older session to a newer prompt.
        let boundPromptId = null;
        if (hasSessionContext) {
            boundPromptId = result.sessionContext.isConfirmation
                ? (result.sessionContext.confirmationPromptId ?? null)
                : null;
        } else if (hasExplicitPromptId) {
            boundPromptId = result.confirmationPromptId;
        } else {
            boundPromptId = this._listeningConfirmationId;
        }

        const isStaleSession = Boolean(
            (result && result.isCurrentSession === false) ||
            (hasSessionContext && result.sessionContext.listenEpoch !== undefined && result.sessionContext.listenEpoch !== this._activeListenEpoch)
        );

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
            // If we're awaiting a confirmation answer (or the speech originated
            // from a confirmation-listening session), route the speech there
            // with the session-bound prompt ID.
            if (this._confirmationActive || isConfirmationResult) {
                this._handleConfirmationSpeech(result.final, boundPromptId, { isStaleSession });
                return;
            }
            if (isStaleSession) {
                return;
            }
            this._processCommand(result.final, 'voice');
        }
    }

    /**
     * Route recognized speech while a confirmation is pending.
     * Only explicit "approve"/"cancel" answers bound to the active prompt
     * are accepted; anything else leaves the confirmation pending.
     */
    _handleConfirmationSpeech(text, expectedPromptId = this._listeningConfirmationId, sessionMeta = null) {
        const isStaleSession = Boolean(sessionMeta && sessionMeta.isStaleSession);
        const pendingMeta = permissions.getPendingMeta();

        // Pass the session-bound prompt ID to permissions.answerVoice(). If the
        // session was already stopped/restarted on the same prompt ID, pass null
        // so a stopped session's late result is still rejected.
        const effectiveExpectedPrompt = (isStaleSession && pendingMeta && expectedPromptId === pendingMeta.id)
            ? null
            : expectedPromptId;

        const handled = permissions.answerVoice(text, effectiveExpectedPrompt);
        if (handled === null) {
            const stillPending = permissions.getPendingMeta();
            if (
                !isStaleSession &&
                this._confirmationActive &&
                stillPending &&
                effectiveExpectedPrompt !== null &&
                effectiveExpectedPrompt !== undefined &&
                stillPending.id === effectiveExpectedPrompt
            ) {
                this._speakResponse('Please say "approve" or "cancel".', 'confirmation');
                this._startListening(effectiveExpectedPrompt);
            }
        }
        // else: permissions.onResolved already fired and stopped listening
        return handled;
    }

    /**
     * Process a text or voice command. The entry path explicitly supplies
     * its source; the default preserves compatibility for internal callers.
     */
    async _processCommand(text, source = 'text') {
        // A command arriving is an explicit interaction — clear "stopped".
        this._stopped = false;
        const token = this._generation;

        if (!text || text.trim().length === 0) {
            // No speech detected, go back to wake mode
            this._clearVoiceOwnedAliceState();
            if (this._isActive && this._autoWakeEnabled) {
                this._startWakeDetection();
            }
            return;
        }

        // Add to history
        this._addToHistory('user', text);
        state.addToConversation('user', text);

        state.logActivity(`User said: "${text}"`, 'info');
        state.set('aliceState', CONFIG.states.PROCESSING);
        this._setStatus(VOICE_STATUS.PROCESSING);

        // Process through skill system
        const result = await this._processWithSkills(text, token, source);

        // Speak response (suppressed if Stop was pressed mid-processing)
        this._speakResponse(result.response, result.skill, token);
    }

    /**
     * Public entry point for text-based commands (used by the HUD command
     * input and debug/demo triggers). Routes through the same pipeline as
     * voice commands.
     */
    processText(text) {
        if (!text || !text.trim()) return;
        this._processCommand(text.trim(), 'text');
    }

    /**
     * Process command through skill system.
     * `token` lets in-flight speech be suppressed if the user pressed Stop
     * while the pipeline was running. THE PIPELINE ITSELF IS UNCHANGED:
     * AI Brain → Plan Validator → Agent → Permission Gateway → Skills.
     *
     * Part 6 supplies Interaction Context metadata on the AI Brain call.
     * Source is explicitly passed by the command-entry path; intent comes
     * from the deterministic Part 7C detector; responseDepth comes from the
     * deterministic Part 7D detector; mode comes from the deterministic
     * Part 7E detector; emotionalSignal comes from the deterministic
     * Part 8A detector (explicit phrases only). Nothing is inferred by the
     * factory, and execution behaviour is unchanged.
     */
    async _processWithSkills(text, token = null, source = 'text') {
        state.set('aliceState', CONFIG.states.UNDERSTANDING);

        // 1. AI Brain pipeline (Phase 6.2)
        // Proposes structured plans or responses. Untrusted actions pass through
        // the Plan Validator before reaching the Agent.
        if (CONFIG.ai?.enabled && aiBrain.isEnabled()) {
            try {
                // Part 7A: deterministic turn lifecycle — first command is 'new',
                // subsequent commands in the same conversation are 'follow_up'.
                // Source is explicitly supplied by the command entry path.
                // Part 7C: intent comes from the deterministic detector
                // (pure, conservative, LLM/skill/permission independent).
                // Part 7D: responseDepth comes from the deterministic
                // response-depth detector — only explicit wording in the
                // request changes it, never the apparent complexity of the
                // question. Part 7E: mode comes from the deterministic
                // personality-mode detector (explicit cues only).
                // Part 8A: emotionalSignal comes from the deterministic
                // emotional-signal detector — explicit phrases only, never
                // inferred. The factory below is the single normalization
                // boundary and never performs detection itself.
                const turnType = this._hasHadInteraction ? 'follow_up' : 'new';
                this._hasHadInteraction = true;
                const interactionContext = createInteractionContext({
                    turnType,
                    intent: detectIntent(text).intent,
                    responseDepth: detectResponseDepth(text).depth,
                    mode: detectPersonalityMode(text).mode,
                    emotionalSignal: detectEmotionalSignal(text).signal,
                    source
                });

                const aiResult = await aiBrain.processRequest(text, {
                    interactionContext
                });
                if (aiResult && aiResult.success) {
                    if (aiResult.isMultiStep && Array.isArray(aiResult.plan) && aiResult.plan.length > 0) {
                        // Pass validated plan to existing Agent
                        const agentResult = await agent.executePlan(
                            { isMultiStep: true, goal: aiResult.goal || text, plan: aiResult.plan },
                            (t) => this._speakResponse(t, 'agent', token)
                        );
                        if (agentResult && agentResult.success) {
                            state.set('aliceState', CONFIG.states.COMPLETING);
                            // Part 9B: turn the completed execution result into
                            // the single user-facing response through the
                            // existing context-aware AIBrain synthesis, reusing
                            // the context already built for this request.
                            return {
                                response: await this._synthesizeFinalResponse(text, agentResult, aiResult.context),
                                skill: 'agent'
                            };
                        }
                        if (agentResult) {
                            // Terminal non-success outcomes (failed step,
                            // cancelled task, denied confirmation) keep the
                            // Agent's own response and never run synthesis.
                            state.set('aliceState', CONFIG.states.COMPLETING);
                            return { response: agentResult.response, skill: 'agent' };
                        }
                    } else if (aiResult.response) {
                        // Direct AI response: already user-facing, so it is
                        // returned as-is and never re-synthesized.
                        return { response: aiResult.response, skill: 'ai' };
                    }
                }
            } catch (e) {
                state.logActivity(`AI Brain pipeline error: ${e.message}`, 'warning');
            }
        }

        // 2. Deterministic Fallback: Try the agent first for multi-step goals (Part 4).
        // The agent returns null when the input is not a multi-step task,
        // in which case we fall back to the single-skill path unchanged.
        const agentResult = await agent.process(text, {
            speak: (t) => this._speakResponse(t, 'agent', token)
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
     * Part 9B — final response synthesis for a completed multi-step task.
     *
     * Converts the Agent's completed execution result into the single
     * user-facing response through the existing context-aware
     * aiBrain.generateResponse(), reusing the ContextBuilder context that was
     * already built for this request. No second interaction context is
     * created, no detector is re-run, and nothing is rebuilt: AIBrain formats
     * the supplied context read-only through the ContextBuilder.
     *
     * The user's request stays authoritative and the execution result stays
     * authoritative for the facts the skills produced. This step is
     * presentation only — it executes no tool, requests no permission,
     * bypasses no validation, cannot alter the executed plan, and grants no
     * authority.
     *
     * If synthesis fails or yields no text, the Agent's own completion
     * response is returned unchanged so the user never gets an empty answer.
     *
     * @param {string} request - The original user request
     * @param {Object} agentResult - The completed Agent execution result
     * @param {Object} [context] - The ContextBuilder context built for this request
     * @returns {Promise<string>} The final user-facing response
     */
    async _synthesizeFinalResponse(request, agentResult, context) {
        try {
            // Keep the factual completion report, not the Agent's internal
            // step blackboard, alongside the already-supplied planning context.
            const executionResult = { response: agentResult.response, success: agentResult.success };
            const synthesized = await aiBrain.generateResponse(request, executionResult, context || null);
            if (typeof synthesized === 'string' && synthesized.trim().length > 0) {
                return synthesized;
            }
            state.logActivity('Final response synthesis produced no text — using the task result', 'warning');
        } catch (e) {
            state.logActivity(`Final response synthesis failed: ${e.message}`, 'warning');
        }
        return agentResult.response;
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
            return "I'm ALICE, an AI assistant with skills in calculations, reminders, notes, web search, and memory. Just say 'help' to learn about my skills!";
        }

        // Default response
        const defaults = [
            "That's interesting! I'm not sure how to help with that specifically, but try saying 'help' to learn about my skills.",
            "I understand. I'm here to help you with calculations, reminders, notes, web search, and remembering things. What would you like assistance with?",
            "I'm here to help! Try asking me to calculate something, set a reminder, save a note, or search the web."
        ];

        return defaults[Math.floor(Math.random() * defaults.length)];
    }

    /**
     * Speak the response. The response is always recorded in state (so the
     * HUD renders it even when voice is OFF or was stopped mid-processing);
     * actual TTS output only happens when the request is still current.
     * `token` (optional): generation captured when the command started —
     * if Stop was pressed since, TTS is suppressed.
     */
    _speakResponse(text, skill = null, token = null) {
        // Add to history (always, so text interaction keeps working)
        this._addToHistory('alice', text);
        state.addToConversation('alice', text);
        state.setLastResponse(text);

        const logMsg = skill ? `ALICE (${skill}): "${text}"` : `ALICE: "${text}"`;
        state.logActivity(logMsg, 'info');

        // Callback for UI
        if (this._onAliceSpeak) {
            this._onAliceSpeak(text);
        }

        // Suppress speech when the originating command was invalidated by an
        // explicit Stop/disable while it was in flight (Stage 1A race fix).
        if (token !== null && token !== this._generation) {
            state.logActivity('Response not spoken — voice stopped during processing', 'info');
            return;
        }

        state.set('aliceState', CONFIG.states.SPEAKING);
        const spoken = tts.speak(text);
        if (!spoken && skill === 'confirmation' && this._isActive && !this._stopped && this._confirmationActive) {
            this._startListening(this._confirmationPromptId);
        }
    }

    /**
     * Handle speech recognition error
     */
    _handleSpeechError(error) {
        state.logActivity(`Speech recognition error: ${error}`, 'warning');

        if (error === 'no-speech') {
            // No speech detected — return to wake mode, but never when the
            // user explicitly stopped (Stage 1A race fix).
            if (this._isActive && !this._stopped && this._autoWakeEnabled) {
                this._startWakeDetection();
            }
        } else if (error === 'not-allowed' || error === 'service-not-allowed') {
            state.logActivity('Microphone access denied. Voice disabled — text input still works.', 'danger');
            state.setVoiceState('isMicrophonePermission', false);
            this._bumpGeneration();
            this._isActive = false;
            this._confirmationActive = false;
            this._confirmationPromptId = null;
            this._listeningConfirmationId = null;
            this._shutdownSubsystems();
            state.setVoiceState('isActive', false);
            this._clearVoiceOwnedAliceState();
            this._setStatus(VOICE_STATUS.ERROR, 'Voice unavailable — microphone access denied');
        }
        // 'aborted' / other errors typically follow an explicit stop; the
        // status was already reconciled by the stop path.
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
        this._hasHadInteraction = false;
        state.logActivity('Conversation history cleared', 'info');
    }

    /**
     * Enable/disable wake word detection
     */
    setWakeWordEnabled(enabled) {
        this._wakeWordEnabled = enabled;
        state.setVoiceState('isWakeWordEnabled', enabled);
        if (!enabled) {
            wakeWordDetector.stop();
            state.setVoiceState('isWakeDetectionRunning', false);
        } else if (this._isActive) {
            // Explicitly re-enabling wake is a user action — it lifts the
            // Stop suspension and arms detection again.
            this._stopped = false;
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
     * Manually trigger wake word (Wake button / debug). Preserved in
     * Stage 1A: manual activation works even when wake detection itself is
     * stopped — but only while the voice system is enabled.
     */
    triggerWakeWord() {
        if (!this._isActive) {
            state.logActivity('Voice system is OFF — enable the microphone to use wake', 'warning');
            return false;
        }
        this._handleWakeWord('manual');
        return true;
    }

    /**
     * Stop current speech only (kept for API compatibility). The Stop
     * button uses stopAllActivity() instead — this method never restarts
     * wake detection on its own (Stage 1A fix).
     */
    stopSpeaking() {
        tts.stop();
        if (state.getVoiceState().status === VOICE_STATUS.SPEAKING) {
            this._setStatus(this._isActive ? VOICE_STATUS.READY : VOICE_STATUS.OFF);
            this._clearVoiceOwnedAliceState();
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
