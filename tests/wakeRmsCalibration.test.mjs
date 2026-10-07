// Phase 1.2A deterministic wake/RMS calibration harness.
//
// The analyser is fully synthetic: time-domain bytes and frequency-bin bytes
// are set independently so the legacy detector input and the RMS measurement
// can be compared without a microphone, browser FFT implementation, timers, or
// animation-frame scheduling. The paired frequency fixtures intentionally
// represent controlled legacy analyser readings; they are not an FFT model.
//
// This test does not change production wake thresholds or route wake detection
// through RMS. It exercises the real AudioManager and WakeWordDetector with a
// controllable analyser and fake clock.

import { readFileSync } from 'node:fs';

const ANALYSER_SAMPLES = 256;
const FREQUENCY_BINS = ANALYSER_SAMPLES / 2;

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
// callbacks are deliberately not auto-fired, just like the existing lifecycle
// harness, so each analyser frame has a known timestamp.
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

// Fixed RMS values below are independently recorded calibration expectations
// for getRmsAudioLevel()'s (byte - 128) / 128 normalization. Speech-like burst
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

const silence = signals[0];
const signalByName = (name) => signals.find((signal) => signal.name === name);
const selectSignal = (signal) => { currentSignal = signal; };

const { audioManager } = await import('../js/audio.js');
const { wakeWordDetector } = await import('../js/wakeword.js');

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

console.log('Phase 1.2A — deterministic synthetic analyser calibration');

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

console.log('\nMeasured signal levels (normalized legacy spectrum average and waveform RMS):');
console.log('  Signal                         legacy getAudioLevel()    RMS getRmsAudioLevel()');
const measured = new Map();
for (const signal of signals) {
    selectSignal(signal);
    const frequencyBefore = frequencyReads;
    const waveformBefore = timeDomainReads;
    const legacy = audioManager.getAudioLevel();
    check(`${signal.name}: legacy metric reads only frequency bins`,
        frequencyReads === frequencyBefore + 1 && timeDomainReads === waveformBefore);
    const rms = audioManager.getRmsAudioLevel();
    check(`${signal.name}: RMS metric reads only time-domain samples`,
        frequencyReads === frequencyBefore + 1 && timeDomainReads === waveformBefore + 1);
    near(`${signal.name}: legacy level`, legacy, signal.expectedLegacy);
    near(`${signal.name}: RMS level`, rms, signal.expectedRms);
    measured.set(signal.name, { legacy, rms });
    console.log(`  ${signal.name.padEnd(31)} ${legacy.toFixed(12).padStart(20)}    ${rms.toFixed(12)}`);
}

console.log('\nProduction wake path contract and unchanged cutoffs:');
const wakeSource = readFileSync(new URL('../js/wakeword.js', import.meta.url), 'utf8');
check('legacy silence threshold remains 0.02', wakeWordDetector._silenceThreshold === 0.02);
check('legacy speech threshold remains 0.05', wakeWordDetector._speechThreshold === 0.05);
check('wake loop still consumes getAudioLevel()',
    /const level = audioManager\.getAudioLevel\(\);/.test(wakeSource));
check('wake loop does not consume getRmsAudioLevel()',
    !/getRmsAudioLevel/.test(wakeSource));

// Helper to start a fresh, real detector run at a controlled clock value.
// start() itself processes one initial silence frame; subsequent frames are
// stepped directly through the production _detectLoop() method.
async function armDetector(startAt, onWake = () => {}) {
    if (wakeWordDetector.isRunning()) wakeWordDetector.stop();
    selectSignal(silence);
    fakeNow = startAt;
    wakeWordDetector._lastWakeTime = 0;
    wakeWordDetector.onWake(onWake);
    const started = await wakeWordDetector.start();
    check(`wake detector starts at ${startAt} ms`, started && wakeWordDetector.isRunning());
    check('initial digital silence leaves detector not speaking', !wakeWordDetector._isSpeaking);
    return started;
}
function detectorFrame(signal, timestamp, label) {
    selectSignal(signal);
    fakeNow = timestamp;
    const frequencyBefore = frequencyReads;
    const waveformBefore = timeDomainReads;
    wakeWordDetector._detectLoop();
    check(`${label}: detector reads one legacy frequency frame`, frequencyReads === frequencyBefore + 1);
    check(`${label}: detector does not read RMS/time-domain data`, timeDomainReads === waveformBefore);
}

console.log('\nDetector state transitions under controlled frames:');
await armDetector(10_000);
check('digital silence increments the silence path',
    !wakeWordDetector._isSpeaking && wakeWordDetector._silenceCount === 1);
detectorFrame(signalByName('very quiet waveform'), 10_050, 'quiet waveform');
check('very quiet waveform stays below the legacy silence cutoff',
    !wakeWordDetector._isSpeaking && wakeWordDetector._silenceCount === 2 && wakeWordDetector._speechCount === 0);
detectorFrame(signalByName('moderate waveform'), 10_100, 'moderate waveform');
check('moderate waveform enters speaking using its legacy level',
    wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 1);
detectorFrame(signalByName('louder waveform'), 10_150, 'louder waveform');
check('louder waveform remains in the same speaking segment',
    wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 2);
wakeWordDetector.stop();
check('stop cancels the current detector run', !wakeWordDetector.isRunning());

// This fixture is deliberately below 0.05 RMS but above 0.05 in the legacy
// frequency average. A speaking transition therefore proves the current
// detector still follows the legacy signal, not the new RMS measurement.
let noiseWakeCount = 0;
await armDetector(20_000, () => noiseWakeCount++);
const noise = signalByName('noise-like varying signal');
check('noise fixture RMS is below the unchanged legacy speech cutoff',
    measured.get(noise.name).rms < wakeWordDetector._speechThreshold);
check('noise fixture legacy level is above the unchanged speech cutoff',
    measured.get(noise.name).legacy > wakeWordDetector._speechThreshold);
detectorFrame(noise, 20_050, 'noise-like signal');
check('noise-like fixture enters speaking because legacy level exceeds 0.05',
    wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 1);
check('short noise probe has not triggered a wake', noiseWakeCount === 0);
wakeWordDetector.stop();

// A short voiced-like burst begins and ends normally but remains below the
// production 0.8 s minimum phrase duration, so it must not schedule a wake.
let shortWakeCount = 0;
await armDetector(30_000, () => shortWakeCount++);
for (let i = 0; i <= 5; i++) {
    detectorFrame(signalByName('short speech-like burst'), 30_050 + i * 50, `short burst frame ${i + 1}`);
}
check('short burst enters speaking', wakeWordDetector._isSpeaking);
for (let i = 1; i <= 7; i++) {
    detectorFrame(silence, 30_300 + i * 50, `short burst silence ${i}`);
}
check('short burst returns to non-speaking state after silence', !wakeWordDetector._isSpeaking);
check('short burst is cleared without scheduling the wake debounce',
    wakeWordDetector._audioBuffer.length === 0 && fakeTimeouts.every((timer) => timer.cancelled));
check('short speech-like burst did not trigger a wake', shortWakeCount === 0);
wakeWordDetector.stop();

// Sustained speech-like input exceeds the unchanged duration/buffer checks;
// the real detector ends the segment on silence and schedules its 100 ms
// debounce. The fake timer is then fired at the same generation token.
let sustainedWakeCount = 0;
await armDetector(40_000, () => sustainedWakeCount++);
for (let i = 0; i <= 20; i++) {
    detectorFrame(signalByName('sustained speech-like signal'), 40_050 + i * 50, `sustained speech frame ${i + 1}`);
}
check('sustained signal remains in speaking state while legacy energy is present',
    wakeWordDetector._isSpeaking && wakeWordDetector._speechCount === 21);
for (let i = 1; i <= 7; i++) {
    detectorFrame(silence, 41_050 + i * 50, `sustained signal silence ${i}`);
}
check('sustained signal returns to non-speaking state on silence', !wakeWordDetector._isSpeaking);
check('sustained signal schedules one 100 ms wake debounce',
    fakeTimeouts.filter((timer) => !timer.cancelled && timer.delay === 100).length === 1);
check('wake callback is delayed until debounce is flushed', sustainedWakeCount === 0);
fakeNow = 41_500;
check('the scheduled debounce is flushed once', flushFakeTimeouts(100) === 1);
check('sustained speech-like segment triggers the existing wake callback', sustainedWakeCount === 1);
check('wake timestamp follows the controlled clock', wakeWordDetector._lastWakeTime === fakeNow);
wakeWordDetector.stop();

// Cleanup follows the normal production stop path; no permission, generation,
// lifecycle, or capture implementation has been patched by this test.
audioManager.stopCapture();
check('cleanup stops capture and clears the analyser buffers',
    !audioManager.isCapturing() && audioManager._timeDomainData === null && audioManager._audioData === null);
check('cleanup leaves wake detection stopped', !wakeWordDetector.isRunning());

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
