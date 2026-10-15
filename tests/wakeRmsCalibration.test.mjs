// Phase 1.2B deterministic wake/RMS migration harness.
//
// Phase 1.2A measured the legacy frequency-domain level and the new normalized
// time-domain RMS side by side. Phase 1.2B migrates the REAL production wake
// detector onto RMS, so this harness now verifies the migration itself:
//
//   * the detector calls audioManager.getRmsAudioLevel() and never
//     audioManager.getAudioLevel() — asserted at the source level AND by
//     counting, cumulatively, every metric read performed from inside the
//     production detection loop;
//   * the detector's state machine reacts to the RMS fixtures exactly as it
//     used to react to the legacy metric (silence / very quiet / moderate /
//     louder / speech-like / noise / short burst / sustained speech);
//   * the negative guards drive the two metrics in OPPOSITE directions, which
//     is what makes the migration falsifiable: a deliberately loud legacy
//     metric over a silent waveform must NOT wake the detector, and a
//     deliberately silent legacy metric over a loud waveform must;
//   * the thresholds were NOT recalibrated, and the deterministic evidence for
//     retaining 0.02 / 0.05 is asserted explicitly.
//
// The analyser is fully synthetic: time-domain bytes and frequency-bin bytes
// are set independently, so the two metrics can be driven apart on purpose.
// No microphone, browser FFT, real timer, or animation frame is involved.
//
// SYNTHETIC FIXTURES ARE NOT MICROPHONE CALIBRATION. The retention decision
// asserted here only shows that the carried-over thresholds stay coherent for
// this metric swap on deterministic fixtures. Live-device calibration (real
// hardware, browser AGC, real room noise) remains PENDING and is not claimed
// by this file — see the honesty note in js/wakeword.js.

import { readFileSync } from 'node:fs';

const ANALYSER_SAMPLES = 256;
const FREQUENCY_BINS = ANALYSER_SAMPLES / 2;
const FRAME_MS = 50; // detector frame spacing used by the transition tests

// --- Deterministic browser/analyser mocks -----------------------------------

let currentSignal;
let frequencyReads = 0;
let timeDomainReads = 0;
let getUserMediaCalls = 0;
let fakeNow = 10_000;
let nextRafId = 0;
const fakeTimeouts = [];
let nextTimeoutId = 0;

class MockAudioContext {
    createMediaStreamSource() {
        return { connect() {} };
    }

    createAnalyser() {
        return {
            _fftSize: 2048,
            get fftSize() { return this._fftSize; },
            set fftSize(value) { this._fftSize = value; },
            get frequencyBinCount() { return this._fftSize / 2; },
            smoothingTimeConstant: 0,
            getByteFrequencyData(target) {
                frequencyReads++;
                target.set(currentSignal.frequencyBins);
            },
            getByteTimeDomainData(target) {
                timeDomainReads++;
                target.set(currentSignal.samples);
            }
        };
    }

    close() {}
}

globalThis.window = {
    AudioContext: MockAudioContext,
    webkitAudioContext: undefined
};
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        mediaDevices: {
            async getUserMedia() {
                getUserMediaCalls++;
                return {
                    getTracks() {
                        return [{ stop() {} }];
                    }
                };
            }
        }
    }
});

// Calls to the detector are advanced explicitly by this test. The scheduled
// callbacks are deliberately not auto-fired, just like the lifecycle harness,
// so each analyser frame has a known timestamp.
globalThis.requestAnimationFrame = () => ++nextRafId;
globalThis.cancelAnimationFrame = () => {};

// The detector's 100 ms debounce is manually flushed below. No real wall-clock
// sleeps are needed, so duration and cancellation assertions are deterministic.
globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const timer = {
        id: ++nextTimeoutId,
        callback: () => callback(...args),
        delay,
        cancelled: false
    };
    fakeTimeouts.push(timer);
    return timer.id;
};
globalThis.clearTimeout = (id) => {
    const timer = fakeTimeouts.find((entry) => entry.id === id);
    if (timer) timer.cancelled = true;
};
Date.now = () => fakeNow;

const byteSamples = (sampleAt) => Uint8Array.from(
    { length: ANALYSER_SAMPLES },
    (_, i) => sampleAt(i)
);
const frequencyBytes = (valueAt) => Uint8Array.from(
    { length: FREQUENCY_BINS },
    (_, i) => valueAt(i)
);
const constantBins = (value) => frequencyBytes(() => value);
const variedBins = (values) => frequencyBytes((i) => values[i % values.length]);

let noiseSeed = 0x12345678;
const noiseSamples = byteSamples(() => {
    noiseSeed = (Math.imul(1664525, noiseSeed) + 1013904223) >>> 0;
    const offset = ((noiseSeed >>> 16) % 17) - 8;
    return 128 + offset;
});
const speechLikeSamples = byteSamples((i) => Math.max(0, Math.min(255, Math.round(
    128
        + 22 * Math.sin((2 * Math.PI * i) / 32)
        + 9 * Math.sin((2 * Math.PI * i) / 16)
        + 5 * Math.sin((2 * Math.PI * i) / 8)
))));

// Fixed RMS values below are independently recorded expectations for
// getRmsAudioLevel()'s (byte - 128) / 128 normalization. The speech-like burst
// and sustained fixtures use the same repeating voiced-like frame; duration is
// controlled by the number of detector frames in the transition tests.
const signals = [
    {
        name: 'digital silence',
        samples: byteSamples(() => 128),
        frequencyBins: constantBins(0),
        expectedLegacy: 0,
        expectedRms: 0
    },
    {
        name: 'very quiet waveform',
        samples: byteSamples((i) => i % 2 === 0 ? 127 : 129),
        frequencyBins: constantBins(4),
        expectedLegacy: 4 / 255,
        expectedRms: 0.0078125
    },
    {
        name: 'moderate waveform',
        samples: byteSamples((i) => i % 2 === 0 ? 112 : 144),
        frequencyBins: constantBins(20),
        expectedLegacy: 20 / 255,
        expectedRms: 0.125
    },
    {
        name: 'louder waveform',
        samples: byteSamples((i) => i % 2 === 0 ? 64 : 192),
        frequencyBins: constantBins(64),
        expectedLegacy: 64 / 255,
        expectedRms: 0.5
    },
    {
        name: 'short speech-like burst',
        samples: speechLikeSamples,
        frequencyBins: variedBins([20, 21, 22, 23]),
        expectedLegacy: 21.5 / 255,
        expectedRms: 0.1348646601690005
    },
    {
        name: 'sustained speech-like signal',
        samples: speechLikeSamples,
        frequencyBins: variedBins([20, 21, 22, 23]),
        expectedLegacy: 21.5 / 255,
        expectedRms: 0.1348646601690005
    },
    {
        name: 'noise-like varying signal',
        samples: noiseSamples,
        frequencyBins: variedBins([16, 24]),
        expectedLegacy: 20 / 255,
        expectedRms: 0.039004473503010784
    }
];

// Negative guards: both metrics are driven in OPPOSITE directions so the
// detector's behaviour can only be explained by one of them. Synthetic by
// design — these prove WHICH measurement the production call site consumes.
const guardLegacyLoudRmsSilent = {
    name: 'guard legacy-loud / RMS-silent',
    samples: byteSamples(() => 128),        // midpoint → RMS exactly 0
    frequencyBins: constantBins(255),       // full-scale spectrum → legacy 1.0
    expectedLegacy: 1,
    expectedRms: 0
};
const guardLegacySilentRmsLoud = {
    name: 'guard legacy-silent / RMS-loud',
    samples: byteSamples((i) => i % 2 === 0 ? 64 : 192), // ±64 square → RMS 0.5
    frequencyBins: constantBins(0),                        // empty spectrum → legacy 0
    expectedLegacy: 0,
    expectedRms: 0.5
};

const silence = signals[0];
const signalByName = (name) => signals.find((signal) => signal.name === name);
const selectSignal = (signal) => { currentSignal = signal; };

const { audioManager } = await import('../js/audio.js');
const { wakeWordDetector } = await import('../js/wakeword.js');

// --- Metric accounting -------------------------------------------------------
// The detector must reach the microphone amplitude through
// audioManager.getRmsAudioLevel() at RUNTIME. The wrappers below delegate to
// the real implementations, so every measured value still comes from
// production AudioManager code — they only record which method was reached.
//
//   metricCalls — calls since the last resetMetricCalls() (per-frame checks)
//   loopReads   — cumulative calls made while the production detection loop is
//                 executing, and only then (whole-file migration proof)
const metricCalls = { legacy: 0, rms: 0 };
const loopReads = { legacy: 0, rms: 0 };
let detectionLoopRuns = 0;
let detectionLoopActive = false;
const valuesReturnedByRms = [];

const realGetAudioLevel = audioManager.getAudioLevel.bind(audioManager);
const realGetRmsAudioLevel = audioManager.getRmsAudioLevel.bind(audioManager);
audioManager.getAudioLevel = (...args) => {
    metricCalls.legacy++;
    if (detectionLoopActive) loopReads.legacy++;
    return realGetAudioLevel(...args);
};
audioManager.getRmsAudioLevel = (...args) => {
    metricCalls.rms++;
    if (detectionLoopActive) loopReads.rms++;
    const value = realGetRmsAudioLevel(...args);
    valuesReturnedByRms.push(value);
    return value;
};
const resetMetricCalls = () => {
    metricCalls.legacy = 0;
    metricCalls.rms = 0;
};
// Run a production detection loop under the accounting flag. The async form
// keeps the flag set across start()'s awaits (start() processes one frame).
function withDetectionLoop(fn) {
    detectionLoopActive = true;
    detectionLoopRuns++;
    try {
        return fn();
    } finally {
        detectionLoopActive = false;
    }
}
async function withDetectionLoopAsync(fn) {
    detectionLoopActive = true;
    detectionLoopRuns++;
    try {
        return await fn();
    } finally {
        detectionLoopActive = false;
    }
}

let passed = 0;
let failed = 0;
function check(name, condition) {
    if (condition) {
        passed++;
        console.log('  PASS', name);
    } else {
        failed++;
        console.log('  FAIL', name);
    }
}
function near(name, actual, expected, tolerance = 1e-12) {
    check(`${name}: got ${actual}, expected ${expected}`,
        Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance);
}
function flushFakeTimeouts(maxDelay) {
    const due = fakeTimeouts.filter((timer) => !timer.cancelled && timer.delay <= maxDelay);
    for (const timer of due) {
        timer.cancelled = true;
        timer.callback();
    }
    return due.length;
}
const liveTimers = () => fakeTimeouts.filter((timer) => !timer.cancelled);
const bandOf = (level) => level < wakeWordDetector._silenceThreshold ? 'silence'
    : level > wakeWordDetector._speechThreshold ? 'speech' : 'dead-band';

console.log('Phase 1.2B — production wake detector migrated to time-domain RMS');

// Start real AudioManager capture against a fake stream/context; the test
// bypasses permission prompting only, not the production analyser setup.
selectSignal(silence);
audioManager._permissionStatus = 'granted';
const stream = await audioManager.startCapture();
check('fake microphone capture starts', stream !== null && audioManager.isCapturing());
check('one controlled getUserMedia acquisition is used', getUserMediaCalls === 1);
check('analyser has the expected 256-sample waveform buffer',
    audioManager._timeDomainData instanceof Uint8Array && audioManager._timeDomainData.length === ANALYSER_SAMPLES);
check('analyser has the expected 128-bin legacy spectrum buffer',
    audioManager._audioData instanceof Uint8Array && audioManager._audioData.length === FREQUENCY_BINS);

// ============================================================================
console.log('\nA) Fixture measurements — legacy spectrum average vs waveform RMS');
console.log('  Signal                         legacy  band        RMS       band');
const measured = new Map();
for (const signal of signals) {
    selectSignal(signal);
    const frequencyBefore = frequencyReads;
    const waveformBefore = timeDomainReads;

    resetMetricCalls();
    const legacy = audioManager.getAudioLevel();
    check(`${signal.name}: getAudioLevel() reads only frequency bins`,
        frequencyReads === frequencyBefore + 1 && timeDomainReads === waveformBefore);
    check(`${signal.name}: that read reached the legacy API only`,
        metricCalls.legacy === 1 && metricCalls.rms === 0);

    resetMetricCalls();
    const rms = audioManager.getRmsAudioLevel();
    check(`${signal.name}: getRmsAudioLevel() reads only time-domain samples`,
        frequencyReads === frequencyBefore + 1 && timeDomainReads === waveformBefore + 1);
    check(`${signal.name}: that read reached the RMS API only`,
        metricCalls.rms === 1 && metricCalls.legacy === 0);

    near(`${signal.name}: legacy level`, legacy, signal.expectedLegacy);
    near(`${signal.name}: RMS level`, rms, signal.expectedRms);
    measured.set(signal.name, { legacy, rms });
    console.log(`  ${signal.name.padEnd(31)} ${legacy.toFixed(6).padStart(9)} ${bandOf(legacy).padEnd(10)} ${rms.toFixed(6).padStart(9)} ${bandOf(rms)}`);
}

const legacyOf = (name) => measured.get(name).legacy;
const rmsOf = (name) => measured.get(name).rms;

// ============================================================================
console.log('\nB) Threshold retention decision (deterministic evidence only)');
// The thresholds came from the legacy metric. Nothing below is microphone
// calibration; it only checks that 0.02 / 0.05 stay coherent for this swap.
check('legacy silence threshold was 0.02 and is retained',
    wakeWordDetector._silenceThreshold === 0.02);
check('legacy speech threshold was 0.05 and is retained',
    wakeWordDetector._speechThreshold === 0.05);

for (const name of ['digital silence', 'very quiet waveform']) {
    check(`retention: "${name}" stays under the 0.02 silence cutoff under RMS`,
        rmsOf(name) < wakeWordDetector._silenceThreshold);
}
const voicedFixtures = ['moderate waveform', 'louder waveform', 'short speech-like burst'];
for (const name of voicedFixtures) {
    check(`retention: "${name}" exceeds the 0.05 speech cutoff under RMS`,
        rmsOf(name) > wakeWordDetector._speechThreshold);
    check(`retention: "${name}" is at least as loud under RMS as under the legacy metric`,
        rmsOf(name) >= legacyOf(name));
}
const smallestVoicedMargin = Math.min(
    ...voicedFixtures.map((name) => rmsOf(name) / wakeWordDetector._speechThreshold));
console.log(`  smallest speech-band margin under RMS: ${smallestVoicedMargin.toFixed(3)}x the 0.05 cutoff`);

// Every fixture whose legacy band differs from its RMS band is listed here.
// Only the non-speech noise fixture may change, and it must move OUT of the
// speech band (never into it), because that is the one classification shift
// the metric swap is expected to cause on this fixture set.
const bandChanges = signals
    .filter((signal) => bandOf(signal.expectedLegacy) !== bandOf(signal.expectedRms))
    .map((signal) => signal.name);
check('no fixture that the legacy metric kept silent moves into the speech band under RMS',
    signals.every((signal) => !(bandOf(signal.expectedLegacy) === 'silence'
        && bandOf(signal.expectedRms) === 'speech')));
check('no fixture that could speak under the legacy metric falls silent under RMS',
    signals.every((signal) => !(bandOf(signal.expectedLegacy) === 'speech'
        && bandOf(signal.expectedRms) === 'silence')));
check('the only threshold-band change is the non-speech noise fixture',
    bandChanges.length === 1 && bandChanges[0] === 'noise-like varying signal');
check('that noise change is speech band (legacy) -> dead band (RMS), never a new trigger',
    bandOf(legacyOf('noise-like varying signal')) === 'speech'
    && bandOf(rmsOf('noise-like varying signal')) === 'dead-band');
console.log('  decision: 0.02 / 0.05 RETAINED unchanged for the migration');
console.log('  (synthetic fixtures only — live microphone calibration is still pending)');

// ============================================================================
console.log('\nC) Production contract — the detector consumes RMS');
const wakeSource = readFileSync(new URL('../js/wakeword.js', import.meta.url), 'utf8');
check('wake loop reads audioManager.getRmsAudioLevel() as its input',
    /const level = audioManager\.getRmsAudioLevel\(\)/.test(wakeSource));
check('wake loop no longer contains any getAudioLevel() call',
    !/getAudioLevel/.test(wakeSource));
check('wakeword.js documents RMS as an amplitude measurement, not a VAD',
    /NOT a VAD/.test(wakeSource));
check('wakeword.js documents that wake-phrase recognition is still absent',
    /NOT actual wake-phrase recognition/.test(wakeSource));
check('wakeword.js documents the retained thresholds',
    /0\.02, speech 0\.05\) were NOT recalibrated/.test(wakeSource));
check('wakeword.js documents that live microphone calibration is still pending',
    /LIVE MICROPHONE CALIBRATION REMAINS PENDING/.test(wakeSource));
check('the state machine constants are unchanged (min/max phrase length)',
    wakeWordDetector._minPhraseLength === 0.8 && wakeWordDetector._maxPhraseLength === 3.0);
check('the state machine constants are unchanged (buffer + cooldown)',
    wakeWordDetector._minBufferSamples === 10 && wakeWordDetector._cooldownMs === 3000);

// Helper to start a fresh, real detector run at a controlled clock value.
// start() itself processes one initial silence frame; subsequent frames are
// stepped directly through the production _detectLoop() method.
async function armDetector(startAt, onWake = () => {}) {
    if (wakeWordDetector.isRunning()) wakeWordDetector.stop();
    selectSignal(silence);
    fakeNow = startAt;
    wakeWordDetector._lastWakeTime = 0;
    wakeWordDetector.onWake(onWake);
    const started = await withDetectionLoopAsync(() => wakeWordDetector.start());
    check(`wake detector starts at ${startAt} ms`, started && wakeWordDetector.isRunning());
    check('initial digital silence leaves detector not speaking', !wakeWordDetector._isSpeaking);
    return started;
}
// Step one production detection frame and prove, per frame, that the RMS path
// (and only the RMS path) was consumed.
function detectorFrame(signal, timestamp, label) {
    selectSignal(signal);
    const expected = audioManager.getRmsAudioLevel(); // independent reference read
    const frequencyBefore = frequencyReads;
    const waveformBefore = timeDomainReads;
    resetMetricCalls();
    fakeNow = timestamp;
    withDetectionLoop(() => wakeWordDetector._detectLoop());
    check(`${label}: detector called getRmsAudioLevel() exactly once and getAudioLevel() never`,
        metricCalls.rms === 1 && metricCalls.legacy === 0);
    check(`${label}: detector read the time domain and never the legacy spectrum`,
        timeDomainReads === waveformBefore + 1 && frequencyReads === frequencyBefore);
    check(`${label}: the level handed to the detector is the RMS (${expected.toFixed(6)})`,
        valuesReturnedByRms[valuesReturnedByRms.length - 1] === expected);
    return expected;
}
function runFrames(signal, startAt, count, label) {
    for (let i = 0; i < count; i++) {
        detectorFrame(signal, startAt + i * FRAME_MS, `${label} frame ${i + 1}`);
    }
}

// ============================================================================
console.log('\nD) State transitions under RMS (unchanged state machine)');
await armDetector(10_000);
check('digital silence takes the silence path (not speaking, silence counted)',
    !wakeWordDetector._isSpeaking && wakeWordDetector._silenceCount === 1);
check('the recorded buffer sample is the RMS of silence (0), not a spectrum value',
    wakeWordDetector._audioBuffer.length === 1 && wakeWordDetector._audioBuffer[0] === 0);

detectorFrame(signalByName('very quiet waveform'), 10_050, 'quiet waveform');
check('very quiet RMS (0.0078) stays below the silence cutoff',
    !wakeWordDetector._isSpeaking && wakeWordDetector._silenceCount === 2 && wakeWordDetector._speechCount === 0);

detectorFrame(signalByName('moderate waveform'), 10_100, 'moderate waveform');
check('moderate RMS (0.125) enters the speaking state',
    wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 1);
check('the speech buffer was reset at speech onset', wakeWordDetector._audioBuffer.length === 0);

detectorFrame(signalByName('louder waveform'), 10_150, 'louder waveform');
check('louder RMS (0.5) remains in the same speaking segment',
    wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 2);
check('the buffer now records the RMS of the louder frame (0.5)',
    wakeWordDetector._audioBuffer.length === 1 && wakeWordDetector._audioBuffer[0] === 0.5);
wakeWordDetector.stop();
check('stop cancels the current detector run', !wakeWordDetector.isRunning());

// ============================================================================
console.log('\nE) Noise fixture under RMS — dead band, never a wake');
// The noise fixture sits at legacy 0.0784 (speech band) but RMS 0.0390, i.e.
// strictly inside the 0.02–0.05 dead band. This is the one documented
// classification change caused by the metric swap, and it makes the detector
// LESS likely to false-trigger on a varying non-speech signal.
let noiseWakeCount = 0;
await armDetector(20_000, () => noiseWakeCount++);
const noiseRms = rmsOf('noise-like varying signal');
check('noise fixture RMS is below the speech cutoff',
    noiseRms < wakeWordDetector._speechThreshold);
check('noise fixture legacy level is above the speech cutoff (why the probe matters)',
    legacyOf('noise-like varying signal') > wakeWordDetector._speechThreshold);
runFrames(signalByName('noise-like varying signal'), 20_050, 25, 'noise-like signal');
check('25 noise frames never enter the speaking state',
    !wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 0);
check('the dead band neither speaks nor counts silence',
    wakeWordDetector._silenceCount === 1 && wakeWordDetector._audioBuffer.length === 26);
check('the noise run recorded RMS values, never the louder legacy ones',
    wakeWordDetector._audioBuffer[0] === 0
    && wakeWordDetector._audioBuffer.slice(1).every((level) => Math.abs(level - noiseRms) < 1e-12));
runFrames(silence, 21_350, 8, 'noise cleanup silence');
check('returning to silence leaves the detector non-speaking', !wakeWordDetector._isSpeaking);
check('sustained noise plus silence scheduled no wake debounce',
    liveTimers().length === 0 && noiseWakeCount === 0);
check('the detector run so far never reached the legacy API', loopReads.legacy === 0);
wakeWordDetector.stop();

// ============================================================================
console.log('\nF) Short speech-like burst — RMS speech, still too short to wake');
let shortWakeCount = 0;
await armDetector(30_000, () => shortWakeCount++);
runFrames(signalByName('short speech-like burst'), 30_050, 6, 'short burst');
check('short burst enters speaking from its RMS value', wakeWordDetector._isSpeaking);
runFrames(silence, 30_350, 7, 'short burst silence');
check('short burst returns to non-speaking after silence', !wakeWordDetector._isSpeaking);
check('short burst is cleared without scheduling the wake debounce',
    wakeWordDetector._audioBuffer.length === 0 && liveTimers().length === 0);
check('short speech-like burst did not trigger a wake', shortWakeCount === 0);
wakeWordDetector.stop();

// ============================================================================
console.log('\nG) Sustained speech-like RMS — existing debounce and cooldown behaviour');
let sustainedWakeCount = 0;
await armDetector(40_000, () => sustainedWakeCount++);
runFrames(signalByName('sustained speech-like signal'), 40_050, 21, 'sustained speech');
check('sustained RMS remains in speaking with the expected speech count',
    wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 21);
runFrames(silence, 41_100, 8, 'sustained signal silence');
check('sustained signal returns to non-speaking on silence', !wakeWordDetector._isSpeaking);
check('sustained signal schedules exactly one 100 ms wake debounce',
    liveTimers().filter((timer) => timer.delay === 100).length === 1);
check('wake callback is delayed until the debounce is flushed', sustainedWakeCount === 0);
fakeNow = 41_500;
check('the scheduled debounce is flushed once', flushFakeTimeouts(100) === 1);
check('sustained speech-like RMS triggers the existing wake callback', sustainedWakeCount === 1);
check('wake timestamp follows the controlled clock', wakeWordDetector._lastWakeTime === fakeNow);
check('the detector reports the cooldown right after a wake', wakeWordDetector.isInCooldown() === true);
const wakeCountBeforeManual = sustainedWakeCount;
wakeWordDetector.triggerManually();
check('manual trigger is suppressed while the cooldown is active',
    sustainedWakeCount === wakeCountBeforeManual);
wakeWordDetector.stop();

// ============================================================================
console.log('\nH) Negative guards — the migration must be real, not coincidental');
// Guard 1: legacy metric pinned at 1.0 while the waveform is digital silence.
// If the detector still consumed the legacy metric it would speak here.
selectSignal(guardLegacyLoudRmsSilent);
near('guard 1: the legacy metric really is 1.0 for this fixture',
    audioManager.getAudioLevel(), guardLegacyLoudRmsSilent.expectedLegacy);
near('guard 1: the RMS really is 0 for the same fixture',
    audioManager.getRmsAudioLevel(), guardLegacyLoudRmsSilent.expectedRms);
let guardOneWakeCount = 0;
const loopReadsBeforeGuardOne = loopReads.rms;
await armDetector(60_000, () => guardOneWakeCount++);
const guardOneFrames = 30;
runFrames(guardLegacyLoudRmsSilent, 60_050, guardOneFrames, 'guard 1 legacy-loud');
check('guard 1: detector never enters speaking while the waveform is silent',
    !wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 0);
check('guard 1: every recorded level is the RMS (0), never the legacy 1.0',
    wakeWordDetector._audioBuffer.length === guardOneFrames + 1
    && wakeWordDetector._audioBuffer.every((level) => level === 0));
runFrames(silence, 62_000, 8, 'guard 1 silence');
check('guard 1: no wake was scheduled or triggered by the loud legacy metric',
    guardOneWakeCount === 0 && liveTimers().length === 0);
check('guard 1: the detection loop performed one RMS read per frame and zero legacy reads',
    loopReads.rms - loopReadsBeforeGuardOne === guardOneFrames + 1 + 8
    && loopReads.legacy === 0);
wakeWordDetector.stop();

// Guard 2: legacy metric pinned at 0.0 while the waveform is a ±64 square
// (RMS 0.5). A detector still reading the legacy metric could never speak here.
selectSignal(guardLegacySilentRmsLoud);
near('guard 2: the legacy metric really is 0 for this fixture',
    audioManager.getAudioLevel(), guardLegacySilentRmsLoud.expectedLegacy);
near('guard 2: the RMS really is 0.5 for the same fixture',
    audioManager.getRmsAudioLevel(), guardLegacySilentRmsLoud.expectedRms);
let guardTwoWakeCount = 0;
await armDetector(70_000, () => guardTwoWakeCount++);
detectorFrame(guardLegacySilentRmsLoud, 70_050, 'guard 2 RMS-loud');
check('guard 2: detector enters speaking from the RMS alone',
    wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 1);
detectorFrame(guardLegacySilentRmsLoud, 70_100, 'guard 2 RMS-loud');
check('guard 2: detector stays in the same speaking segment',
    wakeWordDetector._speechCount === 2);
check('guard 2: the buffered level is the RMS (0.5), not the legacy 0',
    wakeWordDetector._audioBuffer.length === 1
    && wakeWordDetector._audioBuffer[0] === 0.5);
runFrames(guardLegacySilentRmsLoud, 70_150, 19, 'guard 2 RMS-loud');
runFrames(silence, 71_100, 8, 'guard 2 silence');
check('guard 2: the RMS-only segment schedules the normal 100 ms debounce',
    liveTimers().filter((timer) => timer.delay === 100).length === 1);
fakeNow = 71_500;
check('guard 2: the debounce is flushed once', flushFakeTimeouts(100) === 1);
check('guard 2: wake detection followed RMS and triggered the wake callback',
    guardTwoWakeCount === 1);
check('guard 2: the detection loop never reached the legacy API either',
    loopReads.legacy === 0);
wakeWordDetector.stop();

// ============================================================================
console.log('\nI) Stop still cancels the detector and its pending wake');
let stopWakeCount = 0;
await armDetector(80_000, () => stopWakeCount++);
runFrames(signalByName('sustained speech-like signal'), 80_050, 21, 'stop-cancel speech');
runFrames(silence, 81_100, 8, 'stop-cancel silence');
check('stop-cancel: a 100 ms wake debounce is pending before Stop',
    liveTimers().filter((timer) => timer.delay === 100).length === 1);
wakeWordDetector.stop();
check('stop-cancel: Stop leaves the detector stopped', !wakeWordDetector.isRunning());
fakeNow = 81_600;
check('stop-cancel: flushing the stale debounce fires no wake', flushFakeTimeouts(100) === 1);
check('stop-cancel: the cancelled trigger recorded no wake time and no callback',
    stopWakeCount === 0 && wakeWordDetector._lastWakeTime === 0);
check('stop-cancel: a stopped detector reads no metric at all',
    (() => {
        resetMetricCalls();
        wakeWordDetector._detectLoop(); // not counted: the loop exits immediately
        return metricCalls.rms === 0 && metricCalls.legacy === 0;
    })());
const restartAfterStop = await wakeWordDetector.start();
check('stop-cancel: detector restarts cleanly after Stop on a fresh generation',
    restartAfterStop === true && wakeWordDetector.isRunning() === true);
wakeWordDetector.stop();
check('stop-cancel: detector stopped again for cleanup', wakeWordDetector.isRunning() === false);

// ============================================================================
console.log('\nJ) Whole-file accounting and cleanup');
// Every detection-loop execution in this harness must have performed exactly
// one RMS read and zero legacy reads. This is the cumulative proof that the
// production call site follows getRmsAudioLevel().
console.log(`  detection loop ran ${detectionLoopRuns} times, performing ${loopReads.rms} RMS reads and ${loopReads.legacy} legacy reads`);
check('every detection-loop run performed exactly one RMS read',
    loopReads.rms === detectionLoopRuns);
check('no detection-loop run ever performed a legacy metric read',
    loopReads.legacy === 0);

// Cleanup follows the normal production stop path; no permission, generation,
// lifecycle, or capture implementation has been patched by this test.
audioManager.stopCapture();
check('cleanup stops capture and clears the analyser buffers',
    !audioManager.isCapturing() && audioManager._timeDomainData === null && audioManager._audioData === null);
check('cleanup leaves wake detection stopped', !wakeWordDetector.isRunning());
check('after cleanup the migrated read fails safely (RMS 0, no analyser)',
    audioManager.getRmsAudioLevel() === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
