// Part 8A: deterministic emotional-signal detector.
// Detection only — no tone, diagnosis, or response-behavior assertions.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
    DETECTION_CONFIDENCES,
    EMOTIONAL_SIGNALS,
    detectEmotionalSignal
} from '../js/ai/emotionalSignalDetector.js';
import { INTERACTION_EMOTIONAL_SIGNALS } from '../js/ai/interactionContext.js';

const PHRASES = {
    happy: [
        'i am happy', "i'm happy", 'i feel happy', "i'm feeling happy",
        'i am glad', "i'm glad", 'i feel good', "i'm feeling good"
    ],
    sad: [
        'i am sad', "i'm sad", 'i feel sad', "i'm feeling sad",
        'i am upset', "i'm upset", 'i feel down', "i'm feeling down"
    ],
    angry: [
        'i am angry', "i'm angry", 'i feel angry', "i'm feeling angry",
        'i am mad', "i'm mad", "i'm furious"
    ],
    frustrated: [
        'i am frustrated', "i'm frustrated", 'i feel frustrated',
        "i'm feeling frustrated", 'this is frustrating', "i'm getting frustrated"
    ],
    confused: [
        'i am confused', "i'm confused", 'i feel confused', "i'm feeling confused",
        "i don't understand", 'i dont understand', "i'm lost", 'i am lost'
    ],
    nervous: [
        'i am nervous', "i'm nervous", 'i feel nervous', "i'm feeling nervous",
        'i am anxious', "i'm anxious", 'i feel anxious', "i'm worried"
    ],
    excited: [
        'i am excited', "i'm excited", 'i feel excited', "i'm feeling excited",
        "i can't wait", 'i cant wait', 'this is exciting'
    ],
    tired: [
        'i am tired', "i'm tired", 'i feel tired', "i'm feeling tired",
        'i am exhausted', "i'm exhausted", 'i feel exhausted'
    ],
    lonely: [
        'i am lonely', "i'm lonely", 'i feel lonely', "i'm feeling lonely",
        'i feel alone', "i'm feeling alone"
    ],
    curious: [
        'i am curious', "i'm curious", 'i feel curious', "i'm wondering", 'i wonder'
    ],
    bored: [
        'i am bored', "i'm bored", 'i feel bored', "i'm feeling bored", "i'm so bored"
    ]
};

function label(request) {
    if (typeof request === 'bigint') return `${request}n`;
    if (typeof request === 'symbol') return request.toString();
    try { return JSON.stringify(request); } catch { return String(request); }
}

function expectSignal(request, signal, confidence = signal === 'neutral' ? 'low' : 'high') {
    const result = detectEmotionalSignal(request);
    assert.equal(result instanceof Promise, false, 'detector must be synchronous');
    assert.equal(typeof result.then, 'undefined');
    assert.deepEqual(result, { signal, confidence }, `request: ${label(request)}`);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Object.keys(result), ['signal', 'confidence']);
    assert.equal(EMOTIONAL_SIGNALS.includes(result.signal), true);
    assert.equal(DETECTION_CONFIDENCES.includes(result.confidence), true);
    assert.equal(typeof result.confidence, 'string');
    assert.equal(typeof result.signal, 'string');
    return result;
}

describe('Part 8A deterministic emotional-signal detector', () => {
    test('exports the exact signal and confidence contracts', () => {
        assert.deepEqual(EMOTIONAL_SIGNALS, [
            'neutral', 'happy', 'sad', 'angry', 'frustrated', 'confused',
            'nervous', 'excited', 'tired', 'lonely', 'curious', 'bored'
        ]);
        assert.deepEqual([...EMOTIONAL_SIGNALS], [...INTERACTION_EMOTIONAL_SIGNALS]);
        assert.deepEqual(DETECTION_CONFIDENCES, ['high', 'low']);
        assert.equal(Object.isFrozen(EMOTIONAL_SIGNALS), true);
        assert.equal(Object.isFrozen(DETECTION_CONFIDENCES), true);
        assert.throws(() => { EMOTIONAL_SIGNALS.push('anxious'); }, TypeError);
        assert.throws(() => { DETECTION_CONFIDENCES.push('medium'); }, TypeError);
    });

    test('module exports only the detector and its two tables', async () => {
        const exports = await import('../js/ai/emotionalSignalDetector.js');
        assert.deepEqual(Object.keys(exports).sort(), [
            'DETECTION_CONFIDENCES', 'EMOTIONAL_SIGNALS', 'detectEmotionalSignal'
        ]);
        assert.equal(typeof exports.detectEmotionalSignal, 'function');
    });

    for (const [signal, phrases] of Object.entries(PHRASES)) {
        test(`explicit ${signal} phrases → ${signal}/high`, () => {
            for (const phrase of phrases) {
                expectSignal(phrase, signal);
                expectSignal(`Well, ${phrase}!`, signal);
                expectSignal(phrase.toUpperCase(), signal);
                expectSignal(`  ${phrase}  `, signal);
            }
        });
    }

    test('neutral fallback when no explicit phrase is present', () => {
        for (const input of [
            'What is photosynthesis?',
            'hello',
            'open youtube',
            'happy birthday',
            'I hate this',
            'I love this',
            'I am okay',
            'I am fine',
            'I am depressed',
            'I have anxiety',
            'I was sad',
            'Am I sad?',
            'You are sad',
            'I am not happy',
            "I'm not sad",
            "I don't feel happy",
            'I am alone in the room',
            'I am furious',
            'I am worried',
            'I feel worried',
            'frustrating',
            'this is not frustrating',
            'I might be sad',
            'set a timer',
            'Explain quantum computing',
            '???',
            '12345'
        ]) expectSignal(input, 'neutral');
    });

    test('empty and non-string input → neutral/low and never throws', () => {
        for (const value of [
            undefined, null, '', '   ', '\n\t', ' \n ',
            0, 1, NaN, Infinity, true, false, 10n,
            {}, [], () => 'i am happy', Symbol('i am happy'),
            new String('i am happy')
        ]) {
            assert.doesNotThrow(() => detectEmotionalSignal(value));
            expectSignal(value, 'neutral');
        }
        assert.doesNotThrow(() => detectEmotionalSignal());
        expectSignal(undefined, 'neutral');

        const hostile = {
            toString() { throw new Error('boom'); },
            valueOf() { throw new Error('boom'); }
        };
        assert.doesNotThrow(() => detectEmotionalSignal(hostile));
        expectSignal(hostile, 'neutral');

        const coercing = { toString() { return 'I am happy'; }, marker: 1 };
        expectSignal(coercing, 'neutral');
        assert.equal(coercing.marker, 1);
    });

    test('whitespace, case, and curly apostrophe normalization', () => {
        expectSignal('  I   AM    HAPPY  ', 'happy');
        expectSignal('I\nam\n\nhappy', 'happy');
        expectSignal('I\tfeel\ttired', 'tired');
        expectSignal('I\u2019m excited!', 'excited');
        expectSignal('I\u2018m sad', 'sad');
        expectSignal('I don\u2019t understand', 'confused');
        expectSignal('I can\u2019t wait', 'excited');
        expectSignal('I\u2019m so bored', 'bored');
        expectSignal('I\u201Bm frustrated', 'frustrated');
        expectSignal('I\u2032m worried', 'nervous');
        expectSignal('  I\u2019M   FEELING   HAPPY  ', 'happy');
        const spaced = 'I   am    confused';
        const snapshot = spaced;
        expectSignal(spaced, 'confused');
        assert.equal(spaced, snapshot, 'caller string must not be mutated');
    });

    test('partial words and near-misses do not match', () => {
        for (const input of [
            'happiness', 'happily', 'unhappy', 'I am happily surprised',
            'sadness', 'sadly', 'I am saddened', 'I am sadly mistaken',
            'madness', 'madly', 'madison', 'I am madison', 'I am madly in love', 'I am made of stars',
            'angrily', 'anger', 'I am anger',
            'frustratingly', 'frustration', 'this is frustratingly slow',
            'confusing', 'confusion', 'I understand', 'I do understand',
            'nervously', 'nervousness', 'nervous', 'anxiously', 'anxious', 'anxiety',
            'excitedly', 'excitement', 'exciting', 'this is excitedly announced',
            'tiredness', 'retired', 'I am retired', 'tired',
            'loneliness', 'lonely', 'alone', 'I am alone',
            'curiously', 'curiosity', 'wonderful', 'wonderland', 'I wondered', 'wonder', 'ai wonder',
            'boredom', 'boring', 'bored',
            'i amhappy', "i'mhappy", 'iam happy', 'feel happy', 'so happy',
            'i am happyish', 'i am happiness',
            'hi wonder', 'xi\'m happy'
        ]) expectSignal(input, 'neutral');

        // A partial hit must not hide a later explicit phrase.
        expectSignal('I am happily surprised, but I am happy', 'happy');
        expectSignal('this is frustratingly worded, yet this is frustrating', 'frustrated');
    });

    test('precedence is frustrated → angry → sad → nervous → confused → lonely → tired → excited → happy → curious → bored', () => {
        expectSignal('I am angry and I am frustrated', 'frustrated');
        expectSignal('I am frustrated and I am bored', 'frustrated');
        expectSignal('I am sad and I am angry', 'angry');
        expectSignal('I am nervous and I am sad', 'sad');
        expectSignal("I am confused and I'm worried", 'nervous');
        expectSignal("I don't understand and I am lonely", 'confused');
        expectSignal('I am tired and I am lonely', 'lonely');
        expectSignal('I am excited and I am tired', 'tired');
        expectSignal('I am happy and I am excited', 'excited');
        expectSignal('I wonder why I am happy', 'happy');
        expectSignal('I am bored and I wonder why', 'curious');
        expectSignal('I am bored', 'bored');
        expectSignal(
            'I am bored, I wonder, I am happy, I am excited, I am tired, I am lonely, I am confused, I am nervous, I am sad, I am angry, and I am frustrated',
            'frustrated'
        );
        // Appearance order does not matter; there is no scoring.
        expectSignal('I am happy. I am sad. I am frustrated.', 'frustrated');
        expectSignal('I am frustrated. I am happy. I am sad.', 'frustrated');
    });

    test('returned objects are fresh, frozen, and deterministic', () => {
        const first = detectEmotionalSignal('I am happy');
        const second = detectEmotionalSignal('I am happy');
        const neutralA = detectEmotionalSignal('hello');
        const neutralB = detectEmotionalSignal('hello');
        assert.notStrictEqual(first, second);
        assert.notStrictEqual(neutralA, neutralB);
        assert.deepEqual(first, second);
        assert.deepEqual(neutralA, neutralB);
        assert.throws(() => { first.signal = 'sad'; }, TypeError);
        assert.throws(() => { delete first.confidence; }, TypeError);
        assert.deepEqual(first, { signal: 'happy', confidence: 'high' });

        const forward = ['I am happy', 'I am sad', '', null].map(detectEmotionalSignal);
        const reverse = [null, '', 'I am sad', 'I am happy'].map(detectEmotionalSignal);
        assert.deepEqual(forward[0], reverse[3]);
        assert.deepEqual(forward[1], reverse[2]);
        assert.deepEqual(forward[2], reverse[1]);
        assert.deepEqual(forward[3], reverse[0]);

        const padded = `${'x'.repeat(8000)} I am curious ${'y'.repeat(8000)}`;
        expectSignal(padded, 'curious');
        expectSignal('x'.repeat(8000), 'neutral');
    });

    test('detector source has no imports, network, I/O, scoring, or randomness', async () => {
        const src = await readFile(new URL('../js/ai/emotionalSignalDetector.js', import.meta.url), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert.doesNotMatch(code, /\bimport\b|\brequire\s*\(/);
        assert.doesNotMatch(code, /\bfetch\b|XMLHttpRequest|WebSocket|localStorage|sessionStorage|\bprocess\b|Math\.random|Date\.now|new Date/);
        assert.doesNotMatch(code, /\bscore\b|\bweight\b|embedding|probabilit/);
        assert.match(src, /frustrated → angry → sad → nervous → confused → lonely → tired/);
        assert.match(src, /excited → happy → curious → bored → neutral/);
    });
});
