// Part 7E: deterministic personality mode detector.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { detectPersonalityMode } from '../js/ai/personalityModeDetector.js';

const NONE = { mode: null, confidence: 'low' };
function expectMode(request, mode) {
    const r = detectPersonalityMode(request);
    assert.deepEqual(r, mode ? { mode, confidence: 'high' } : NONE, `request: ${typeof request === "string" ? request : typeof request}`);
    assert.equal(Object.isFrozen(r), true);
    return r;
}

const CUES = {
    soft: ['be gentle', 'gentle mode', 'be kind', 'be comforting', 'comfort me', 'talk gently', 'be soft', 'soft mode'],
    focus: ['help me focus', 'focus mode', 'keep me focused', 'stay focused', 'be focused', "don't distract me", 'no distractions'],
    playful: ['be playful', 'playful mode', 'make it fun', 'have some fun', 'be funny', 'make me laugh', 'joke around', 'lighten the mood'],
    analyst: ['analyze this', 'analysis mode', 'be analytical', 'analyze it', 'give me an analysis', 'break this down logically', 'think analytically'],
    guardian: ['guardian mode', 'keep me safe', 'help me stay safe', 'be protective', 'protective mode', 'what should I be careful about', 'is this safe'],
    teacher: ['teach me', 'teacher mode', 'teach me this', 'teach me from the basics', 'explain like a teacher', 'be my teacher', 'teaching mode', 'help me learn']
};

describe('Part 7E personality mode detector', () => {
    for (const [mode, phrases] of Object.entries(CUES)) {
        test(`explicit ${mode} phrases → ${mode}/high`, () => {
            for (const p of phrases) {
                expectMode(p, mode);
                expectMode(`Please ${p} for a moment.`, mode);
            }
        });
    }

    test('multiple cues obey precedence guardian→focus→teacher→analyst→soft→playful', () => {
        expectMode('be playful and be gentle', 'soft');
        expectMode('be gentle and analyze this', 'analyst');
        expectMode('analyze this and teach me', 'teacher');
        expectMode('teach me but stay focused', 'focus');
        expectMode('stay focused and keep me safe', 'guardian');
        expectMode('be playful, be kind, analyze it, teach me, focus mode, guardian mode', 'guardian');
        expectMode('make me laugh then be soft', 'soft');
    });

    test('no explicit mode → null/low', () => {
        for (const t of ['hello', 'open youtube', 'set a timer for 5 minutes', 'what time is it']) expectMode(t, null);
    });

    test('complex questions, emotion, intent and depth never infer a mode', () => {
        for (const t of [
            'What is quantum mechanics?', 'Explain this in detail.', 'Explain the theory of relativity step by step in detail',
            "I'm sad.", 'I feel anxious and scared', 'I am so happy today!!!', 'I hate this', 'I am lonely',
            'open calculator', 'remind me tomorrow', 'search for flights', 'calculate 2 + 2',
            'give me a quick answer', 'deep dive into markets', 'explain with an example', 'just the answer',
            'Why does this happen?', 'HOW DOES IT WORK?', 'is this dangerous?', 'I want to learn'
        ]) expectMode(t, null);
    });

    test('case, whitespace and curly apostrophe normalization', () => {
        expectMode('BE PLAYFUL', 'playful');
        expectMode('  Guardian   MODE  ', 'guardian');
        expectMode('teach\n\tme', 'teacher');
        expectMode('don\u2019t distract me', 'focus');
        expectMode('Don\u2018t Distract Me', 'focus');
    });

    test('non-string and empty input → null/low', () => {
        for (const v of [undefined, null, 42, true, {}, [], () => 'be playful', Symbol('x'), '', '   ', '\n\t', '?!.']) expectMode(v, null);
        const hostile = { toString() { throw new Error('boom'); } };
        assert.doesNotThrow(() => detectPersonalityMode(hostile));
        expectMode(hostile, null);
    });

    test('no substring false positives', () => {
        for (const t of [
            'be playfully silly', 'playfulness is nice', 'the teachers are here', 'teaching is hard',
            'reteach me', 'overteach me', 'teach meal plans', 'analysis', 'psychoanalyze this', 'analyze thistle',
            'be gentleman', 'be kindness', 'be softer', 'unfocused mode', 'refocus mode', 'guardians mode',
            'keep me safely', 'is this safer', 'be funnyish', 'comfort meal', 'be focusedly', 'make it funny'
        ]) expectMode(t, null);
    });

    test('returned objects are frozen and fresh per call', () => {
        const a = detectPersonalityMode('be playful'), b = detectPersonalityMode('be playful');
        const c = detectPersonalityMode('hi'), d = detectPersonalityMode('hi');
        assert.notEqual(a, b); assert.notEqual(c, d);
        for (const r of [a, b, c, d]) {
            assert.equal(Object.isFrozen(r), true);
            assert.deepEqual(Object.keys(r).sort(), ['confidence', 'mode']);
        }
        assert.throws(() => { 'use strict'; a.mode = 'soft'; });
    });

    test('detector source has no imports, network, I/O, or randomness', async () => {
        const src = await readFile(new URL('../js/ai/personalityModeDetector.js', import.meta.url), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert.doesNotMatch(code, /\bimport\b|\brequire\s*\(/);
        assert.doesNotMatch(code, /\bfetch\b|XMLHttpRequest|WebSocket|localStorage|sessionStorage|\bprocess\b|Math\.random|Date\.now|new Date/);
        assert.match(src, /guardian → focus → teacher → analyst → soft → playful → no mode/);
    });
});
