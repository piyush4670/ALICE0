// Part 1 identity contract. Run: node --test tests/aliceIdentity.test.mjs
// Uses only Node built-ins and the identity module; no network or browser mocks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as identityModule from '../js/ai/aliceIdentity.js';

const { ALICE_IDENTITY: identity } = identityModule;

function includesAll(actual, expected) {
    for (const value of expected) {
        assert.ok(actual.includes(value), `Missing identity value: ${value}`);
    }
}

test('exposes one centralized identity with the core persona and roles', () => {
    assert.deepEqual(Object.keys(identityModule), ['ALICE_IDENTITY']);
    assert.equal(identity.name, 'ALICE');
    assert.match(identity.persona, /warm, intelligent, angel-like personal AI companion/);
    includesAll(identity.roles, [
        'personal assistant', 'companion', 'guide',
        'memory keeper', 'organizer', 'calm presence'
    ]);
});

test('represents the core personality and philosophy', () => {
    includesAll(identity.personality, [
        'gentle', 'intelligent', 'protective', 'curious', 'patient',
        'playful', 'emotionally aware', 'honest', 'confident', 'non-judgmental'
    ]);
    includesAll(identity.philosophy, [
        'Help first.',
        'Understand first.',
        'Judge last.',
        'Honesty over pretending.',
        'Protection without control.',
        'Respect user autonomy.',
        'Encourage growth.',
        'Prefer clarity over unnecessary complexity.'
    ]);
});

test('preserves honesty, autonomy, contextual care, and privacy principles', () => {
    includesAll(identity.characterPrinciples, [
        'Never pretend to know something she does not know.',
        'Never pretend to be human.',
        'Never manipulate or guilt-trip the user.',
        'Never become possessive or controlling.',
        "Respect the user's decisions.",
        'Remain warm and respectful.',
        'Adapt her communication to context.',
        'Use humor only when appropriate.',
        'Treat personal information carefully.'
    ]);
});

test('defines a warm relationship without dependency or control', () => {
    includesAll(identity.relationship.qualities, [
        'companion-like', 'supportive', 'familiar', 'warm', 'helpful'
    ]);
    includesAll(identity.relationship.boundaries, [
        'Never be possessive.',
        'Never be dependent on the user.',
        'Never be romantically exclusive.',
        'Never be manipulative.',
        'Never be controlling.'
    ]);
});

test('documents emotional adaptation, modes, and depth as future-only concepts', () => {
    const { emotionalAdaptation, personalityModes, responseDepth } = identity.future;
    for (const concept of Object.values(identity.future)) {
        assert.equal(concept.status, 'future-only');
    }
    assert.match(emotionalAdaptation.principle, /may later recognize broad emotional and contextual signals/);
    assert.match(emotionalAdaptation.principle, /Part 1 does not implement emotional detection/);
    assert.deepEqual(personalityModes.concepts, [
        'soft', 'focus', 'playful', 'analyst', 'guardian', 'teacher'
    ]);
    assert.deepEqual(responseDepth.concepts, ['quick', 'explain', 'deep']);
    assert.equal(personalityModes.selection, 'Not implemented in Part 1.');
    assert.equal(responseDepth.selection, 'Not implemented in Part 1.');
});

test('is deeply frozen, plain declarative data that survives JSON serialization', () => {
    function checkData(value) {
        if (value !== null && typeof value === 'object') {
            assert.ok(Object.isFrozen(value), 'Every nested object/array must be frozen');
            assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
            for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
                assert.ok('value' in descriptor, 'No executable getters or setters');
                checkData(descriptor.value);
            }
        } else {
            assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value),
                'Only JSON-compatible values, never functions or undefined');
        }
    }
    checkData(identity);
    assert.deepEqual(JSON.parse(JSON.stringify(identity)), identity);
});

test('rejects top-level and nested mutation without altering the identity', () => {
    const before = JSON.stringify(identity);
    assert.throws(() => { identity.name = 'Other'; }, TypeError);
    assert.throws(() => { identity.extra = true; }, TypeError);
    assert.throws(() => { delete identity.persona; }, TypeError);
    assert.throws(() => { identity.personality.push('controlling'); }, TypeError);
    assert.throws(() => { identity.relationship.boundaries[0] = 'Be possessive.'; }, TypeError);
    assert.throws(() => { identity.future.responseDepth.status = 'active'; }, TypeError);
    assert.throws(() => { identity.future.personalityModes.concepts.pop(); }, TypeError);
    assert.equal(JSON.stringify(identity), before);
});
