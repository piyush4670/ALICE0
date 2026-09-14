/**
 * ALICE Voice Lifecycle Status (Stage 1A)
 * ------------------------------------------------------------------
 * Single source of truth for the voice interaction lifecycle. Every
 * subsystem (STT / TTS / wake detection) reports through the
 * ConversationManager, which transitions this status; the HUD only
 * ever RENDERS it. This replaces the previous situation where several
 * modules independently guessed whether ALICE was listening/speaking.
 *
 * Lifecycle:
 *
 *   OFF        voice system disabled (no mic capture, no STT/TTS/wake)
 *   READY      voice enabled and idle (wake detection may be armed)
 *   LISTENING  STT session actually running
 *   PROCESSING a command is being run through the pipeline
 *   SPEAKING   TTS utterance in progress
 *   STOPPING   transient state while an explicit Stop tears subsystems down
 *   ERROR      voice unavailable (e.g. microphone permission denied)
 */
export const VOICE_STATUS = Object.freeze({
    OFF: 'OFF',
    READY: 'READY',
    LISTENING: 'LISTENING',
    PROCESSING: 'PROCESSING',
    SPEAKING: 'SPEAKING',
    STOPPING: 'STOPPING',
    ERROR: 'ERROR'
});

export function isVoiceStatus(value) {
    return Object.values(VOICE_STATUS).includes(value);
}
