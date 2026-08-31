// Regression tests for the prototype authentication module (run with node).
//
// Pins the auth hardening fixes:
//   - a PIN is never accepted merely because it has a valid length
//   - only the configured PIN's digest verifies (existing repository hash)
//   - empty / malformed / unexpected input is rejected without consuming attempts
//   - max-attempt and lockout behavior is preserved (and lockout expires)
//   - authentication succeeds again once conditions are valid
//   - PIN values are never written to the activity log
//
// No browser globals are needed: js/auth.js only touches the DOM through the
// `authScreen` argument, which is faked below.
const { auth } = await import('../js/auth.js');
const { state } = await import('../js/state.js');
const { CONFIG } = await import('../js/config.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

// --- Minimal stand-in for the auth screen DOM -----------------------------
function makeAuthScreen() {
    const status = { textContent: '', classList: { add() {}, remove() {} } };
    const input = { value: '', classList: { add() {}, remove() {} }, focus() {} };
    return {
        status,
        input,
        querySelector(sel) {
            if (sel === '.auth-status') return status;
            if (sel === '.auth-input') return input;
            return null;
        }
    };
}

// --- Fast timers ------------------------------------------------------------
// Short delays (the simulated verification delay, success delay, shake
// cleanup) resolve immediately. Long timers (the 30s lockout) are captured
// so the test can fire them manually instead of waiting.
const realSetTimeout = globalThis.setTimeout;
const capturedTimers = [];
globalThis.setTimeout = (fn, ms) => {
    if (ms >= 1000) { capturedTimers.push(fn); return capturedTimers.length; }
    return realSetTimeout(fn, 0);
};
function fireCapturedTimers() {
    const timers = capturedTimers.splice(0);
    for (const fn of timers) fn();
}

const CORRECT = CONFIG.auth.defaultPin; // configured PIN ('1234')
const WRONG = '9999';
if (CORRECT === WRONG) throw new Error('test configuration conflict: WRONG PIN equals configured PIN');

console.log('1) Correct PIN authenticates');
auth.logout(); // reset singleton state
state.set('isAuthenticated', false);
const screen1 = makeAuthScreen();
const r1 = await auth.authenticate(CORRECT, screen1);
check('success: true', r1.success === true);
check('isAuthenticated set in state', state.get('isAuthenticated') === true);
check('status shows "Access granted"', screen1.status.textContent === 'Access granted');
check('not locked after success', auth.isLocked() === false);

console.log('2) Incorrect PIN is rejected (no length-based acceptance)');
auth.logout();
state.set('isAuthenticated', false);
const screen2 = makeAuthScreen();
const r2 = await auth.authenticate(WRONG, screen2);
check('success: false', r2.success === false);
check('message: Invalid PIN', r2.message === 'Invalid PIN');
check('isAuthenticated stays false', state.get('isAuthenticated') === false);
check('attempt counted', auth.getAttemptsRemaining() === CONFIG.auth.maxAttempts - 1);
check('status shows "Access denied."', screen2.status.textContent.includes('Access denied'));
check('input cleared after failure', screen2.input.value === '');

console.log('3) Regression: wrong PINs with a "valid" length are never accepted');
for (const bad of ['0000', '1111', '4321', '12345', '98765432', '12340']) {
    if (bad === CORRECT) continue; // safety: never test the real PIN as wrong
    auth.logout();
    const rb = await auth.authenticate(bad, makeAuthScreen());
    check(`"${bad}" (${bad.length} chars) rejected`, rb.success === false);
}

console.log('4) Empty and malformed input rejected without consuming attempts');
auth.logout();
const before = auth.getAttemptsRemaining();
const cases = [
    ['', 'empty string'],
    ['12', 'too short'],
    ['1', 'single digit'],
    ['123456789', 'too long (9 digits)'],
    ['abcd', 'non-digit letters'],
    ['12a4', 'mixed digits/letters'],
    [' 1234', 'leading whitespace'],
    ['12 34', 'internal whitespace'],
    [1234, 'number instead of string'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ pin: '1234' }, 'object']
];
for (const [value, label] of cases) {
    const rc = await auth.authenticate(value, makeAuthScreen());
    check(`${label} rejected`, rc.success === false && typeof rc.message === 'string' && rc.message.length > 0);
}
check('malformed input consumed no attempts', auth.getAttemptsRemaining() === before);
check('not locked after malformed input', auth.isLocked() === false);
const rEmpty = await auth.authenticate('', makeAuthScreen());
check('empty PIN gets a specific message', /enter your PIN/i.test(rEmpty.message));

console.log('5) Successful authentication after earlier failures (below the limit)');
// one failure has already occurred in section 2 semantics; do one more, then succeed
auth.logout();
await auth.authenticate(WRONG, makeAuthScreen());
check('one failure recorded', auth.getAttemptsRemaining() === CONFIG.auth.maxAttempts - 1);
const r5 = await auth.authenticate(CORRECT, makeAuthScreen());
check('correct PIN still succeeds after failures', r5.success === true);
check('isAuthenticated set', state.get('isAuthenticated') === true);

console.log('6) Repeated failed attempts trigger lockout');
auth.logout();
state.set('isAuthenticated', false);
let last = null;
for (let i = 0; i < CONFIG.auth.maxAttempts; i++) {
    last = await auth.authenticate(WRONG, makeAuthScreen());
}
check('final failure reports lockout', last.success === false && /locked/i.test(last.message));
check('system is locked', auth.isLocked() === true);
check('attempts remaining clamped at 0 (not negative)', auth.getAttemptsRemaining() === 0);
check('isAuthenticated still false', state.get('isAuthenticated') === false);

console.log('7) Lockout blocks even the correct PIN until it expires');
const rLocked = await auth.authenticate(CORRECT, makeAuthScreen());
check('correct PIN rejected while locked', rLocked.success === false);
check('locked message shown', /locked/i.test(rLocked.message));
check('still locked after rejected attempt', auth.isLocked() === true);
check('lockout timer was scheduled', capturedTimers.length === 1);

console.log('8) Lockout expires and authentication succeeds again');
fireCapturedTimers(); // simulate the lockout duration elapsing
check('unlocked after timeout', auth.isLocked() === false);
check('attempts reset after timeout', auth.getAttemptsRemaining() === CONFIG.auth.maxAttempts);
const r8 = await auth.authenticate(CORRECT, makeAuthScreen());
check('correct PIN succeeds after lockout expiry', r8.success === true);
check('isAuthenticated set after recovery', state.get('isAuthenticated') === true);

console.log('9) Concurrent submissions are guarded');
auth.logout();
const pFirst = auth.authenticate(CORRECT, makeAuthScreen()); // starts, sets in-flight guard
const rSecond = await auth.authenticate(WRONG, makeAuthScreen());
check('second call while verifying is rejected', rSecond.success === false && /in progress/i.test(rSecond.message));
check('second call consumed no attempts', auth.getAttemptsRemaining() === CONFIG.auth.maxAttempts);
const rFirst = await pFirst;
check('first call completes normally', rFirst.success === true);

console.log('10) PIN values are never logged');
const messages = state.get('activityLog').map(l => String(l.message));
check('correct PIN never appears in logs', messages.every(m => !m.includes(CORRECT)));
check('wrong PIN never appears in logs', messages.every(m => !m.includes(WRONG)));
check('failed attempts are still logged', messages.some(m => /Failed authentication attempt/.test(m)));
check('lockout is logged', messages.some(m => /System locked due to too many failed attempts/.test(m)));

// Restore real timers before exit
globalThis.setTimeout = realSetTimeout;

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
