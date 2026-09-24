import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { detectResponseDepth } from '../js/ai/responseDepthDetector.js';

function expectDepth(request, depth, confidence = 'high') {
    const result = detectResponseDepth(request);
    assert.deepEqual(result, { depth, confidence });
    assert.equal(Object.isFrozen(result), true);
    return result;
}

describe('Part 7D deterministic response-depth detector', () => {
    test('explicit deep phrases return deep/high', () => {
        for (const phrase of [
            'in detail', 'detailed explanation', 'explain in detail',
            'deep explanation', 'go deep', 'deep dive', 'thoroughly',
            'step by step in detail', 'with detailed examples'
        ]) expectDepth(`Tell me ${phrase}`, 'deep');
    });

    test('explicit explain phrases return explain/high', () => {
        for (const phrase of [
            'explain', 'explain this', 'explain that', 'how does this work',
            'how does it work', 'why does this happen',
            'give me an explanation', 'with an example', 'give an example'
        ]) expectDepth(phrase, 'explain');
    });

    test('explicit quick phrases return quick/high', () => {
        for (const phrase of [
            'just the answer', 'short answer', 'briefly', 'in short',
            'keep it short', 'quick answer', 'just tell me', 'only the answer'
        ]) expectDepth(phrase, 'quick');
    });

    test('no explicit cue defaults to quick/low, regardless of complexity', () => {
        expectDepth('What is quantum chromodynamics and how does it relate to gauge symmetry?', 'quick', 'low');
        expectDepth('What time is it?', 'quick', 'low');
        expectDepth('', 'quick', 'low');
        expectDepth('   \t\n ', 'quick', 'low');
        for (const input of [null, undefined, 42, true, {}, [], Symbol('request')]) {
            expectDepth(input, 'quick', 'low');
        }
    });

    test('precedence is deep, then explain, then quick', () => {
        expectDepth('explain in detail; just the answer', 'deep');
        expectDepth('explain this, briefly', 'explain');
        expectDepth('give an example, only the answer', 'explain');
    });

    test('case, whitespace, and curly apostrophe normalization work without mutation', () => {
        const request = '  EXPLAIN   THIS  '; const snapshot = request;
        expectDepth(request, 'explain');
        assert.equal(request, snapshot);
        expectDepth('what’s the answer? JUST   TELL   ME', 'quick');
    });

    test('phrase matching has no substring false positives', () => {
        for (const input of [
            'explanation of the topic', 'deeply consider the issue',
            'shortage of answers', 'quickly solve this',
            'tell me something', 'give an exampled result'
        ]) expectDepth(input, 'quick', 'low');
    });

    test('results are fresh frozen objects and the module has no imports or I/O', async () => {
        const first = detectResponseDepth('explain this');
        const second = detectResponseDepth('explain this');
        assert.notStrictEqual(first, second);
        assert.throws(() => { first.depth = 'deep'; }, TypeError);
        assert.throws(() => { delete first.confidence; }, TypeError);
        const source = await readFile(new URL('../js/ai/responseDepthDetector.js', import.meta.url), 'utf8');
        assert.doesNotMatch(source, /^\s*import\s/m);
        assert.doesNotMatch(source, /\b(fetch|require|XMLHttpRequest|WebSocket|localStorage)\s*\(/);
    });
});
