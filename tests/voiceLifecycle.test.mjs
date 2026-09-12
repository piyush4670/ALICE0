// Stage 1A voice lifecycle tests (node). Browser globals mocked.
//
// Covers the Stage 1A acceptance matrix deterministically:
//   A) Startup         — no automatic microphone request, voice OFF
//   B) Text pipeline   — works with voice OFF, TTS end does not arm wake
//   C) Mic enable      — permission granted → Voice READY + wake detection
//   D) Full voice loop — wake → listening → command → speaking → auto-wake
//   E) STOP while listening  → stopped, no stale STT restart
//   F) STOP while speaking   → stopped, no wake resurrection
//   G) STOP while wake armed → stopped, mic released, no auto-restart
//   H) Voice disable   → OFF, TTS end cannot restart wake
//   I) Permission denied → Voice unavailable, text still works
//   J) Settings        — single coherent settings structure (duplicate fixed)
//   K) Race guards     — Stop during the 300 ms STT start delay
//
// No production behavior is changed by this file.

import { setTimeout as delay } from 'node:timers/promises';

// --- Controllable mocks -----------------------------------------------------

let micDenied = false;
let getUserMediaCalls = 0;
const trackStops = [];
const fakeStream = () => ({ getTracks: () => [{ stop() { trackStops.push(1); } }] });

class MockSpeechRecognition {
    static instances = [];
    static liveStarts = 0;
    constructor() {
        MockSpeechRecognition.instances.push(this);
        this.continuous = false;
        this.interimResults = false;
        this.lang = '';
        this.maxAlternatives = 1;
        this._live = false;
    }
    start() {
        if (this._live) throw new Error('InvalidStateError: already started');
        this._live = true;
        MockSpeechRecognition.liveStarts++;
        if (this.onstart) this.onstart();
    }
    stop() {
        if (!this._live) return;
        this._live = false;
        if (this.onend) this.onend();
    }
    abort() { this._live = false; }
    // Test helper: deliver a final result, then end the session (Chrome order)
    userSays(text) {
        if (!this._live) throw new Error('userSays on a dead recognition session');
        const results = [[{ transcript: text, confidence: 1 }]];
        results[0].isFinal = true;
        if (this.onresult) this.onresult({ resultIndex: 0, results });
        this.stop();
    }
}
const lastRecognition = () => MockSpeechRecognition.instances[MockSpeechRecognition.instances.length - 1];

const pendingUtterances = [];
const synthMock = {
    speak(u) { pendingUtterances.push(u); },
    cancel() {
        const pending = pendingUtterances.splice(0);
        for (const u of pending) {
            // Chrome-style: cancel fires error(canceled) and end
            if (u.onerror) u.onerror({ error: 'canceled' });
            if (u.onend) u.onend();
        }
    },
    getVoices() { return [{ name: 'Mock Voice', lang: 'en-US' }]; },
    pause() {}, resume() {},
    onvoiceschanged: null
};

class MockAudioContext {
    constructor() {}
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
        return {
            fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 8,
            getByteFrequencyData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = 0; }
        };
    }
    close() {}
}

// --- Browser globals (must exist BEFORE the app modules are imported) -------

globalThis.localStorage = {
    _d: {}, getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: synthMock,
    SpeechRecognition: MockSpeechRecognition,
    webkitSpeechRecognition: undefined,
    AudioContext: MockAudioContext,
    webkitAudioContext: undefined,
    open() {}
};
globalThis.speechSynthesis = synthMock;
globalThis.SpeechSynthesisUtterance = class {
    constructor(text) { this.text = text; this.voice = null; this.rate = 1; this.pitch = 1; this.volume = 1; this.lang = ''; }
};
Object.defineProperty(globalThis, 'navigator', {
    value: {
        mediaDevices: {
            getUserMedia: async () => {
                getUserMediaCalls++;
                if (micDenied) {
                    const e = new Error('Permission denied');
                    e.name = 'NotAllowedError';
                    throw e;
                }
                return fakeStream();
            }
        },
        permissions: undefined
    },
    configurable: true
});

// rAF: captured but never auto-fired — wake detection stays deterministic
let rafId = 0;
globalThis.requestAnimationFrame = () => ++rafId;
globalThis.cancelAnimationFrame = () => {};

// Minimal DOM: elements capture their event listeners so the test can
// click buttons and submit forms the way a user would.
function fakeElement() {
    return {
        style: {}, value: '', textContent: '', innerHTML: '', className: '',
        classList: {
            _s: new Set(),
            add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
            toggle(c, force) { force ? this._s.add(c) : this._s.delete(c); },
            contains(c) { return this._s.has(c); }
        },
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        querySelector() { return fakeElement(); },
        querySelectorAll() { return []; },
        appendChild() {}, removeChild() {}, setAttribute() {},
        getContext() { return null; }
    };
}
const namedElements = {};
const domReadyHandlers = [];
globalThis.document = {
    getElementById(id) { if (!namedElements[id]) namedElements[id] = fakeElement(); return namedElements[id]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return fakeElement(); },
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') domReadyHandlers.push(fn); },
    body: { appendChild() {}, removeChild() {} },
    title: 'Voice Lifecycle Test'
};
globalThis.Blob = class { constructor() {} };
globalThis.URL = { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ AbstractText: 'ok' }) });

// --- Import app modules under test ------------------------------------------

const { state } = await import('../js/state.js');
const { VOICE_STATUS } = await import('../js/voiceStatus.js');
const { conversation } = await import('../js/conversation.js');
const { wakeWordDetector } = await import('../js/wakeword.js');
const { stt } = await import('../js/stt.js');
const { tts } = await import('../js/tts.js');
const { audioManager } = await import('../js/audio.js');
const { settings } = await import('../js/settings.js');
await import('../js/app.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}
const click = (id) => {
    const el = namedElements[id];
    if (!el || !el.listeners.click || !el.listeners.click.length) throw new Error(`no click listener on #${id}`);
    el.listeners.click[0]({ preventDefault() {} });
};
const submit = (id) => {
    const el = namedElements[id];
    el.listeners.submit[0]({ preventDefault() {} });
};
const voiceStatus = () => state.getVoiceState().status;
const speakNextUtterance = () => {
    const u = pendingUtterances.shift();
    if (!u) throw new Error('no pending utterance');
    if (u.onstart) u.onstart();
    if (u.onend) u.onend();
    return u;
};

// ============================================================================
console.log('A) Startup — no automatic microphone start');
for (const fn of domReadyHandlers) fn();
await delay(30);
check('no getUserMedia call after startup', getUserMediaCalls === 0);
check('voice status is OFF after startup', voiceStatus() === VOICE_STATUS.OFF);
check('conversation not active after startup', conversation.isActive() === false);
check('wake detection not running after startup', wakeWordDetector.isRunning() === false);
check('mic not captured after startup', audioManager.isCapturing() === false);

// ============================================================================
console.log('B) Text interaction works with voice OFF (and stays OFF)');
namedElements['command-input'].value = 'hello';
submit('command-form');
await delay(80);
check('text command produced a response', state.get('voice.lastAliceResponse').length > 0);
check('pipeline set PROCESSING or beyond', state.get('conversation').length >= 2);
check('response utterance queued even with voice OFF', pendingUtterances.length === 1);
speakNextUtterance();
await delay(30);
check('voice status back to OFF after speaking (not READY)', voiceStatus() === VOICE_STATUS.OFF);
check('TTS end did NOT arm wake detection while voice disabled', wakeWordDetector.isRunning() === false);
check('no microphone was captured for a text command', audioManager.isCapturing() === false);

// ============================================================================
console.log('C) Mic enable — permission granted → Voice READY');
click('mic-toggle');
await delay(120); // conversation.init() + wake start
check('permission was requested exactly once', getUserMediaCalls >= 1);
check('voice status READY after enable', voiceStatus() === VOICE_STATUS.READY);
check('conversation active', conversation.isActive() === true);
check('wake detection armed', wakeWordDetector.isRunning() === true);
check('state mirrors wake detection running', state.getVoiceState().isWakeDetectionRunning === true);
check('microphone capture active while voice enabled', audioManager.isCapturing() === true);

// ============================================================================
console.log('D) Full voice loop — wake → listen → command → speak → auto-wake');
conversation.triggerWakeWord();
await delay(400); // covers the 300 ms pre-listen delay
check('STT is really listening after manual wake', stt.isListening() === true);
check('voice status LISTENING only when STT live', voiceStatus() === VOICE_STATUS.LISTENING);
check('state.voice.isListening mirrors STT', state.getVoiceState().isListening === true);
// The ack utterance finished while STT is live — must not disturb LISTENING
if (pendingUtterances.length) speakNextUtterance();
check('LISTENING survives a completed ack utterance', voiceStatus() === VOICE_STATUS.LISTENING);
const startsBeforeCommand = MockSpeechRecognition.liveStarts;
lastRecognition().userSays('hello there');
await delay(120);
check('no duplicate STT session for a command', MockSpeechRecognition.liveStarts === startsBeforeCommand);
check('response recorded for voice command', state.get('voice.lastAliceResponse').length > 0);
check('response utterance queued after voice command', pendingUtterances.length >= 1);
speakNextUtterance(); // ALICE speaks the answer to completion
await delay(80);
check('auto-wake re-armed after natural speech end', wakeWordDetector.isRunning() === true);
check('voice status READY after natural speech end', voiceStatus() === VOICE_STATUS.READY);

// ============================================================================
console.log('E) STOP while listening');
conversation.triggerWakeWord();
await delay(400);
check('listening again before Stop test', voiceStatus() === VOICE_STATUS.LISTENING && stt.isListening());
const liveStartsAtStop = MockSpeechRecognition.liveStarts;
click('voice-stop-btn');
await delay(20);
check('STT session ended by Stop', stt.isListening() === false && stt.hasActiveSession() === false);
check('status READY (idle) after Stop while listening', voiceStatus() === VOICE_STATUS.READY);
check('Stop detail recorded', state.getVoiceState().statusDetail === 'Stopped by user');
check('listening flag cleared in state', state.getVoiceState().isListening === false);
check('wake detection stopped by Stop', wakeWordDetector.isRunning() === false);
check('aliceState back to IDLE', state.get('aliceState') === 'IDLE');
await delay(450); // window in which a stale 300 ms-delayed start could fire
check('no stale STT restart after Stop', MockSpeechRecognition.liveStarts === liveStartsAtStop);
check('no wake resurrection after Stop', wakeWordDetector.isRunning() === false);

// ============================================================================
console.log('F) STOP while speaking');
namedElements['command-input'].value = 'hello';
submit('command-form');
await delay(80);
check('utterance pending before Stop', pendingUtterances.length >= 1);
const u = pendingUtterances[0];
if (u.onstart) u.onstart(); // ALICE starts speaking
check('voice status SPEAKING', voiceStatus() === VOICE_STATUS.SPEAKING);
click('voice-stop-btn');
await delay(20);
check('TTS stopped by Stop', tts.isSpeaking() === false);
check('status READY after Stop while speaking', voiceStatus() === VOICE_STATUS.READY);
check('wake NOT re-armed after Stop while speaking', wakeWordDetector.isRunning() === false);
check('cancelled utterance events were drained', pendingUtterances.length === 0);
await delay(250);
check('no delayed wake resurrection from cancelled TTS', wakeWordDetector.isRunning() === false);

// ============================================================================
console.log('G) STOP while wake detection armed');
// re-arm wake via a fresh manual interaction cycle: enable is still on,
// so a manual wake + Stop is the cleanest way back into armed-then-stopped.
conversation.setWakeWordEnabled(true);
await delay(60);
check('wake re-armed when re-enabled by user', wakeWordDetector.isRunning() === true);
click('voice-stop-btn');
await delay(20);
check('wake stopped by Stop', wakeWordDetector.isRunning() === false);
check('microphone released by Stop', audioManager.isCapturing() === false);
check('voice still enabled (READY idle) after Stop', voiceStatus() === VOICE_STATUS.READY && conversation.isActive());
await delay(400);
check('wake stays stopped after explicit Stop', wakeWordDetector.isRunning() === false);

// ============================================================================
console.log('H) Voice disable — everything OFF, nothing restarts');
click('mic-toggle'); // OFF
await delay(30);
check('voice status OFF after disable', voiceStatus() === VOICE_STATUS.OFF);
check('conversation inactive after disable', conversation.isActive() === false);
check('mic released after disable', audioManager.isCapturing() === false);
namedElements['command-input'].value = 'hello';
submit('command-form');
await delay(80);
check('text command still processed with voice OFF (2)', pendingUtterances.length === 1);
speakNextUtterance();
await delay(30);
check('TTS end with voice disabled returns to OFF', voiceStatus() === VOICE_STATUS.OFF);
check('TTS end with voice disabled never arms wake', wakeWordDetector.isRunning() === false);

// ============================================================================
console.log('I) Permission denied — Voice unavailable, text still works');
micDenied = true;
click('mic-toggle');
await delay(80);
check('voice status ERROR when permission denied', voiceStatus() === VOICE_STATUS.ERROR);
check('error detail explains unavailability', /microphone/i.test(state.getVoiceState().statusDetail));
check('conversation not active after denial', conversation.isActive() === false);
namedElements['command-input'].value = 'hello';
submit('command-form');
await delay(80);
check('text interaction works after mic denial', state.get('voice.lastAliceResponse').length > 0);
if (pendingUtterances.length) pendingUtterances.splice(0); // drain
micDenied = false;

// ============================================================================
console.log('J) Settings — single coherent structure (duplicate fixed)');
settings.init();
const s = state.getSettings();
check('settings has ui group (legacy keys preserved)', s.ui && s.ui.soundEnabled === true && s.ui.voiceFeedback === true);
check('settings has proactive group', s.proactive && s.proactive.level === 'moderate');
check('settings has features group', s.features && s.features.vision === true);
check('settings has skills group', typeof s.skills === 'object');
settings.set('proactive', 'level', 'low');
check('settings update through existing API still works', state.getSettings().proactive.level === 'low');
settings.set('proactive', 'level', 'moderate');

// ============================================================================
console.log('K) Race guards — Stop inside the STT start delay');
// Enable voice again, wake manually, then Stop inside the 300 ms window
click('mic-toggle');
await delay(120);
check('voice re-enabled for race test', conversation.isActive() === true);
conversation.triggerWakeWord();
await delay(100); // inside the 300 ms pre-listen delay
click('voice-stop-btn');
await delay(500); // the delayed stt.start() would fire here if unguarded
check('STT never started after Stop inside start delay', stt.hasActiveSession() === false && stt.isListening() === false);
check('status stays consistent after racy Stop', voiceStatus() === VOICE_STATUS.READY);
check('wake not started after racy Stop', wakeWordDetector.isRunning() === false);

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
