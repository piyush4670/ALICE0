// Consolidated regression coverage for ALICE0 (run with node).
//
// One suite covering the core subsystems end-to-end, following the
// repository's existing test style (plain node + mocked browser globals,
// deterministic — no network, no real credentials, no real timers):
//
//   1) AUTH       — valid PIN, invalid PIN, empty input, failed attempts,
//                   lockout (+ recovery)
//   2) PLANNER    — single-step, multi-step, maxSteps enforcement, malformed
//                   plans, unknown skills
//   3) AGENT      — success, failure, retry, retry exhaustion, thrown tool
//                   exception, disabled skill, clean termination
//   4) PERMISSIONS— safe action, sensitive action, approval, denial,
//                   cancellation, duplicate-confirmation prevention, direct
//                   execution safety
//   5) SKILLS     — registration, invalid manifest, disabled skill, unknown
//                   skill, execution failure
//   6) MEMORY     — add, retrieve, search, delete, persistence, error handling
//   7) INTEGRATION— module imports, initialization, core app startup, boot
//
// No production behavior is changed by this file.

// --- Browser globals --------------------------------------------------------
globalThis.localStorage = {
    _d: {}, getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; } },
    open() {}, SpeechRecognition: undefined, webkitSpeechRecognition: undefined,
    AudioContext: undefined, webkitAudioContext: undefined
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: undefined, permissions: undefined }, configurable: true });

// Generic DOM element stand-in (rich enough for app.js / boot.js wiring)
function genericElement() {
    return {
        style: {}, textContent: '', innerText: '', value: '', innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return genericElement(); },
        querySelectorAll() { return []; },
        appendChild() {}, removeChild() {}, remove() {},
        setAttribute() {}, focus() {}, click() {}, getContext() { return null; }
    };
}

// Capture DOMContentLoaded handlers so "app startup" can be triggered
// deterministically instead of relying on a real DOM.
const domListeners = [];
let getElementByIdOverride = null;
globalThis.document = {
    createElement: () => genericElement(),
    body: { appendChild() {}, removeChild() {}, innerText: 'regression page' },
    title: 'Regression Page',
    getElementById(id) { return getElementByIdOverride ? getElementByIdOverride(id) : null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { domListeners.push({ type, fn }); }
};
globalThis.Blob = class { constructor() {} };
globalThis.URL = { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} };
globalThis.Image = class { set src(v) { this._src = v; } };
globalThis.FileReader = class { readAsDataURL() {} };
globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ AbstractText: 'Deterministic offline abstract.', Heading: 'Offline', AbstractURL: 'https://example.invalid/offline' })
});

// --- Fast, deterministic timers --------------------------------------------
// Short delays (verification delay, pacing, retries) resolve immediately.
// Long timers (the 30s auth lockout) are captured so the test can fire them
// manually instead of waiting.
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

// --- Imports + startup snapshot ---------------------------------------------
const { skillManager } = await import('../js/skillManager.js');
const { taskPlanner } = await import('../js/taskPlanner.js');
const { agent } = await import('../js/agent.js');
const { permissions } = await import('../js/permissions.js');
const { memory } = await import('../js/memory.js');
const { auth } = await import('../js/auth.js');
const { bootSequence } = await import('../js/boot.js');
const { state } = await import('../js/state.js');
const { CONFIG } = await import('../js/config.js');

// Snapshot taken BEFORE any test mutates state (asserted in section 7)
const initialSkillCount = skillManager.getSkills().length;
const initiallyUnauthenticated = state.get('isAuthenticated');
const initialAliceState = state.get('aliceState');
const permissionsIdleAtImport = permissions.hasPending() === false;

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

// --- Shared helpers ----------------------------------------------------------
const originalAnalyze = taskPlanner.analyze.bind(taskPlanner);
function injectPlan(plan, goal = 'injected regression goal') {
    taskPlanner.analyze = () => ({ isMultiStep: true, goal, plan });
}
function restorePlanner() { taskPlanner.analyze = originalAnalyze; }
const step = (over = {}) => ({
    id: 'step', label: 'Step', skill: 'reg-ok', operation: null,
    action: 'run', input: 'reg-ok input', inputSource: null, contextKey: 'k',
    risk: 'safe', retries: 0, alternatives: [], filename: null, ...over
});

// Permission prompt harness: counts prompts, auto-answers ('approve'|'deny'),
// or leaves the prompt open for a manual answer (null).
let promptCount = 0;
let lastMeta = null;
let autoMode = null;
permissions.onPrompt((meta) => {
    promptCount++;
    lastMeta = meta;
    if (autoMode === 'approve') setTimeout(() => permissions.answer(true), 0);
    else if (autoMode === 'deny') setTimeout(() => permissions.answer(false), 0);
});

// Minimal auth screen stand-in (same shape as tests/auth.test.mjs)
function makeAuthScreen() {
    const status = { textContent: '', classList: { add() {}, remove() {} } };
    const input = { value: '', classList: { add() {}, remove() {} }, focus() {} };
    return {
        status, input,
        querySelector(sel) {
            if (sel === '.auth-status') return status;
            if (sel === '.auth-input') return input;
            return null;
        }
    };
}

// ============================================================================
console.log('1) AUTH');

const PIN = CONFIG.auth.defaultPin;
const WRONG_PIN = '9999';
if (PIN === WRONG_PIN) throw new Error('test configuration conflict');

const authScreen = makeAuthScreen();
const rAuth1 = await auth.authenticate(PIN, authScreen);
check('valid PIN authenticates', rAuth1.success === true && state.get('isAuthenticated') === true);
check('not locked after valid PIN', auth.isLocked() === false);

auth.logout();
check('logout clears authentication', state.get('isAuthenticated') === false);

const rAuth2 = await auth.authenticate(WRONG_PIN, authScreen);
check('invalid PIN rejected', rAuth2.success === false && rAuth2.message === 'Invalid PIN');
check('failed attempt counted', auth.getAttemptsRemaining() === CONFIG.auth.maxAttempts - 1);
check('still authenticated after failure', state.get('isAuthenticated') === false);

const attemptsBeforeEmpty = auth.getAttemptsRemaining();
const rAuth3 = await auth.authenticate('', authScreen);
check('empty input rejected', rAuth3.success === false && /enter your pin/i.test(rAuth3.message));
check('empty input consumes no attempt', auth.getAttemptsRemaining() === attemptsBeforeEmpty);

// Failed attempts accumulate into lockout
let lastAttempt = null;
for (let i = 0; i < CONFIG.auth.maxAttempts + 2 && !auth.isLocked(); i++) {
    lastAttempt = await auth.authenticate(WRONG_PIN, authScreen);
}
check('repeated failures trigger lockout', auth.isLocked() === true);
check('final failure reports lockout', lastAttempt.success === false && /locked/i.test(lastAttempt.message));
check('attempts remaining clamped at 0', auth.getAttemptsRemaining() === 0);

const rAuthLocked = await auth.authenticate(PIN, authScreen);
check('correct PIN rejected while locked', rAuthLocked.success === false && /locked/i.test(rAuthLocked.message));
check('still locked after rejected attempt', auth.isLocked() === true);

// Lockout recovery (captured timer fires the 30s expiry instantly)
fireCapturedTimers();
check('lockout expires', auth.isLocked() === false);
check('attempts reset after lockout expiry', auth.getAttemptsRemaining() === CONFIG.auth.maxAttempts);
const rAuth4 = await auth.authenticate(PIN, authScreen);
check('valid PIN works again after lockout expiry', rAuth4.success === true);
auth.logout();

// ============================================================================
console.log('2) PLANNER');

const pSingle = taskPlanner.analyze('what time is it');
check('single-step request is not a multi-step task', pSingle.isMultiStep === false && pSingle.plan.length === 0);

const pMulti = taskPlanner.analyze('research quantum computing, summarize the important information and create a document');
check('multi-step request detected', pMulti.isMultiStep === true);
check('multi-step plan has 3 steps', pMulti.plan.length === 3);
check('plan binds real skills (websearch → core → files)',
    pMulti.plan[0].skill === 'websearch' &&
    pMulti.plan[1].skill === 'core' &&
    pMulti.plan[2].skill === 'files');
check('topic extracted for research step', /quantum computing/i.test(pMulti.plan[0].input));

const oversized = Array.from(
    { length: CONFIG.agent.maxSteps + 1 },
    () => 'what time is it'
).join(' and then ');
const pOver = taskPlanner.analyze(oversized);
check('plan exceeding maxSteps is refused, not truncated',
    pOver.isMultiStep === false && pOver.plan.length === 0);
const pAtLimit = taskPlanner.analyze(
    Array.from({ length: CONFIG.agent.maxSteps }, () => 'what time is it').join(' and then ')
);
check('plan of exactly maxSteps is allowed', pAtLimit.isMultiStep === true && pAtLimit.plan.length === CONFIG.agent.maxSteps);

const pEmpty = taskPlanner.analyze('');
check('empty goal yields no plan', pEmpty.isMultiStep === false && pEmpty.plan.length === 0);
injectPlan('not-an-array');
check('malformed (non-array) plan never starts a task',
    (await agent.process('malformed goal', { speak: () => {} })) === null);
injectPlan([step(), null]);
check('plan with a null step is refused',
    (await agent.process('malformed goal', { speak: () => {} })) === null);
restorePlanner();

// Unknown skills: unmatched clauses are dropped, never emitted as steps
const pUnmatched = taskPlanner.analyze('frobnicate the quux and then what time is it');
check('unmatched clause produces no phantom skill step',
    pUnmatched.isMultiStep === false && pUnmatched.plan.length === 0);
const pMixed = taskPlanner.analyze('search the web for cats and then what time is it');
check('connector split maps clauses to known skills',
    pMixed.isMultiStep === true && pMixed.plan.length === 2 &&
    pMixed.plan.every(s => s.skill === 'core' || skillManager.hasSkill(s.skill)));
injectPlan([step({ skill: 'no-such-skill' })]);
const rUnknownStep = await agent.process('unknown skill goal', { speak: () => {} });
check('unknown skill in a plan fails safely (never executed)',
    rUnknownStep && rUnknownStep.success === false && /not available/.test(rUnknownStep.response));
restorePlanner();

// ============================================================================
console.log('3) AGENT');

let okCalls = 0, badCalls = 0, throwCalls = 0, offCalls = 0;
skillManager.register({
    name: 'reg-ok', description: 'Regression skill that succeeds', patterns: [/^reg-ok/],
    execute(input) { okCalls++; return { success: true, result: `ok: ${input}` }; }
});
skillManager.register({
    name: 'reg-bad', description: 'Regression skill that always fails', patterns: [/^reg-bad/],
    execute() { badCalls++; return { success: false, error: 'reg-bad failed' }; }
});
skillManager.register({
    name: 'reg-throw', description: 'Regression skill that throws', patterns: [/^reg-throw/],
    execute() { throwCalls++; throw new Error('kaboom-reg'); }
});
skillManager.register({
    name: 'reg-off', description: 'Regression skill that gets disabled', patterns: [/^reg-off/],
    execute() { offCalls++; return { success: true, result: 'off' }; }
});

injectPlan([step({ input: 'reg-ok alpha' })]);
const rAgentOk = await agent.process('agent success goal', { speak: () => {} });
restorePlanner();
check('successful execution returns success', rAgentOk.success === true);
check('successful task marked completed', state.getTask().status === 'completed' && state.getTask().progress === 100);
check('successful step executed exactly once', okCalls === 1);

injectPlan([step({ skill: 'reg-bad', retries: 0 })]);
const rAgentFail = await agent.process('agent failure goal', { speak: () => {} });
restorePlanner();
check('failed execution reports failure', rAgentFail.success === false);
check('failure message is user-facing', /could not be completed/i.test(rAgentFail.response));
check('task marked failed', state.getTask().status === 'failed');

badCalls = 0;
injectPlan([step({ skill: 'reg-bad', retries: 1 })]);
await agent.process('agent retry goal', { speak: () => {} });
restorePlanner();
check('failed step is retried once (2 calls)', badCalls === 2);

badCalls = 0;
injectPlan([step({ skill: 'reg-bad', retries: 99 })]);
await agent.process('agent retry exhaustion goal', { speak: () => {} });
restorePlanner();
check('excessive retry requests capped at 1 + maxRetries', badCalls === 1 + CONFIG.agent.maxRetries);

throwCalls = 0;
injectPlan([step({ skill: 'reg-throw', retries: 0 })]);
const rAgentThrow = await agent.process('agent exception goal', { speak: () => {} });
restorePlanner();
check('thrown tool exception normalized into safe failure',
    rAgentThrow.success === false && typeof rAgentThrow.response === 'string' && /kaboom-reg/.test(rAgentThrow.response));
check('throwing tool attempted once (no retries requested)', throwCalls === 1);

skillManager.setEnabled('reg-off', false);
injectPlan([step({ skill: 'reg-off' })]);
const rAgentDisabled = await agent.process('agent disabled goal', { speak: () => {} });
restorePlanner();
check('disabled skill fails the task without executing',
    rAgentDisabled.success === false && /disabled/i.test(rAgentDisabled.response) && offCalls === 0);
skillManager.setEnabled('reg-off', true);

check('execution terminated cleanly (state back to idle)', state.get('aliceState') === 'IDLE');
injectPlan([step({ input: 'reg-ok beta' })]);
const rAgentAfter = await agent.process('agent recovery goal', { speak: () => {} });
restorePlanner();
check('agent accepts a new task after termination', rAgentAfter.success === true);
state.resetTask();

// ============================================================================
console.log('4) PERMISSIONS');

const { integrations } = await import('../js/integrations.js');
const lightOn = (id) => integrations.getDevice(id).state.on;

// Safe action: no prompt at all
autoMode = null;
promptCount = 0;
const rPermSafe = await skillManager.executeByName('datetime', 'what time is it right now please');
check('safe action executes without confirmation', rPermSafe.success === true && promptCount === 0);

// Sensitive action + approval: exactly one prompt, real effect
autoMode = 'approve';
promptCount = 0;
const rPermApprove = await skillManager.executeByName('iot', 'turn on the desk lamp');
check('sensitive action asks for confirmation', promptCount === 1);
check('approved sensitive action executes', rPermApprove.success === true);
check('approved action has its real effect', lightOn('light-1') === true);

// Denial: blocked, structured result, no effect
autoMode = 'deny';
promptCount = 0;
const light2Before = lightOn('light-2');
const rPermDeny = await skillManager.executeByName('iot', 'turn on the room light');
check('denied action does not execute', rPermDeny.success === false);
check('denial returns a structured permission result',
    rPermDeny.permission && rPermDeny.permission.decision === 'denied' &&
    rPermDeny.permission.skill === 'iot' && typeof rPermDeny.error === 'string');
check('denied action leaves the device unchanged', lightOn('light-2') === light2Before);

// Cancellation (modal "cancel" button path): terminates safely
autoMode = null;
promptCount = 0;
const light1Before = lightOn('light-1');
const pendingCancel = skillManager.executeByName('iot', 'switch on the desk lamp');
await new Promise(r => realSetTimeout(r, 10));
check('cancellation prompt opens', permissions.hasPending() === true);
permissions.answer(false); // the modal's cancel button
const rPermCancel = await pendingCancel;
check('cancelled action does not execute', rPermCancel.success === false && rPermCancel.permission.decision === 'denied');
check('cancelled action leaves the device unchanged', lightOn('light-1') === light1Before);
check('no prompt left dangling after cancellation', permissions.hasPending() === false);

// Duplicate confirmation prevention: a retried approved step never re-prompts
let flakyCalls = 0;
skillManager.register({
    name: 'reg-flaky', description: 'Sensitive skill that always fails', patterns: [/^reg-flaky/],
    risk: 'sensitive',
    execute() { flakyCalls++; return { success: false, error: 'reg-flaky failed' }; }
});
autoMode = 'approve';
promptCount = 0;
injectPlan([step({ skill: 'reg-flaky', input: 'reg-flaky attempt', retries: 1 })]);
await agent.process('flaky permission goal', { speak: () => {} });
restorePlanner();
check('retried sensitive step runs twice but prompts only once',
    flakyCalls === 2 && promptCount === 1);
state.resetTask();

// Direct execution safety: legacy process() path and context flags cannot bypass
autoMode = 'deny';
promptCount = 0;
const rPermDirect = await skillManager.process('delete my note about RegGuard');
check('direct execution via process() is gated',
    rPermDirect.success === false && rPermDirect.permission && rPermDirect.permission.decision === 'denied');
const rPermFlags = await skillManager.executeByName('notes', 'delete my note about FlagGuard', {
    preApproved: true, approved: true, skipConfirmation: true, permissions: 'granted'
});
check('arbitrary context flags cannot bypass the gateway',
    rPermFlags.success === false && rPermFlags.permission.decision === 'denied' && promptCount === 2);

// ============================================================================
console.log('5) SKILLS');

const regOkSkill = skillManager.register({
    name: 'reg-demo', description: 'Regression demo skill', patterns: [/^reg-demo/],
    execute: () => ({ success: true, result: 'demo ok' })
});
check('valid skill registers', regOkSkill === true && skillManager.hasSkill('reg-demo'));

const regNoDesc = skillManager.register({ name: 'reg-nodesc', patterns: [/x/], execute: () => ({}) });
const regNoExec = skillManager.register({ name: 'reg-noexec', description: 'x', patterns: [/x/] });
const regBadPatterns = skillManager.register({ name: 'reg-badpatterns', description: 'x', patterns: 'nope', execute: () => ({}) });
check('invalid manifests are rejected',
    regNoDesc === false && regNoExec === false && regBadPatterns === false);
check('invalid skills never enter the registry',
    !skillManager.hasSkill('reg-nodesc') && !skillManager.hasSkill('reg-noexec') && !skillManager.hasSkill('reg-badpatterns'));
check('manifest validation reports the reasons',
    skillManager.validateSkill({ name: 'x' }).valid === false && skillManager.validateSkill({ name: 'x' }).errors.length >= 3);

skillManager.setEnabled('reg-demo', false);
check('disabled skill reports disabled', skillManager.isEnabled('reg-demo') === false);
const rSkillDisabled = await skillManager.executeByName('reg-demo', 'reg-demo go');
check('disabled skill cannot execute', rSkillDisabled.success === false && /disabled/i.test(rSkillDisabled.error));
check('disabled skill unavailable without prompting', rSkillDisabled.permission && rSkillDisabled.permission.decision === 'unavailable');
skillManager.setEnabled('reg-demo', true);
check('re-enabled skill executes again',
    (await skillManager.executeByName('reg-demo', 'reg-demo go')).success === true);

const rSkillUnknown = await skillManager.executeByName('reg-ghost', 'hello');
check('unknown skill returns structured unavailability',
    rSkillUnknown.success === false && /not available/i.test(rSkillUnknown.error) &&
    rSkillUnknown.permission && rSkillUnknown.permission.decision === 'unavailable');

skillManager.register({
    name: 'reg-fail', description: 'Regression skill that fails', patterns: [/^reg-fail/],
    execute: () => ({ success: false, error: 'reg-fail failed' })
});
const rSkillFail = await skillManager.executeByName('reg-fail', 'reg-fail now');
check('skill execution failure surfaces unchanged',
    rSkillFail.success === false && rSkillFail.error === 'reg-fail failed');

// ============================================================================
console.log('6) MEMORY');

memory.remember('favorite color', 'green');
check('memory add (remember)', memory.hasMemory('favorite color') === true);
const memoNote = memory.addNote('Shopping list', 'buy oat milk');
check('note add returns the stored note', !!memoNote && !!memoNote.id);

check('memory retrieve (recall)', memory.recall('favorite color') === 'green');
check('note retrieve (getNote)', (memory.getNote(memoNote.id) || {}).content === 'buy oat milk');
check('recall of a missing key returns null', memory.recall('no such key') === null);

check('note search by title', memory.searchNotes('shopping').length === 1);
check('note search by content', memory.searchNotes('oat milk').length === 1);
check('note search with no hit returns empty', memory.searchNotes('zzz-nothing').length === 0);
check('fuzzy recall finds the closest memory',
    (() => { const f = memory.recallFuzzy('favourite colour'); return !!f && f.value === 'green'; })());

check('memory delete (forget)', memory.forget('favorite color') === true && memory.recall('favorite color') === null);
check('forget of a missing key returns false', memory.forget('favorite color') === false);
check('note delete', memory.deleteNote(memoNote.id) === true && memory.searchNotes('shopping').length === 0);
check('note delete of a missing id returns false', memory.deleteNote(memoNote.id) === false);

// Persistence: data survives a fresh module instance ("reload")
memory.remember('persist key', 'survives reload');
const storedRaw = localStorage.getItem('alice_memory');
check('memory is written to storage', !!storedRaw && /persist key/.test(storedRaw));
const { memory: memoryReloaded } = await import('../js/memory.js?fresh-session');
check('persisted memory survives a reload',
    memoryReloaded.recall('persist key') === 'survives reload');
check('reloaded memory still has notes API', Array.isArray(memoryReloaded.getNotes()));

// Error handling: corrupt storage must not break startup
localStorage.setItem('alice_memory', '{corrupt json!!');
let corruptLoadThrew = false;
let memoryCorrupt = null;
try {
    ({ memory: memoryCorrupt } = await import('../js/memory.js?corrupt-session'));
} catch (e) {
    corruptLoadThrew = true;
}
check('corrupt storage does not throw at load', corruptLoadThrew === false && !!memoryCorrupt);
check('corrupt storage starts empty', memoryCorrupt.recall('persist key') === null);

// Error handling: a failing save (quota exceeded) must not throw to callers
const realLocalStorage = globalThis.localStorage;
globalThis.localStorage = {
    getItem: (k) => realLocalStorage.getItem(k),
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem: (k) => realLocalStorage.removeItem(k)
};
let saveThrew = false;
try {
    memoryCorrupt.remember('quota test', 'value');
} catch (e) {
    saveThrew = true;
}
check('failing save is caught, not thrown', saveThrew === false);
check('in-memory value still retrievable after failed save', memoryCorrupt.recall('quota test') === 'value');
globalThis.localStorage = realLocalStorage;

// ============================================================================
console.log('7) INTEGRATION');

// Module imports: every module in the app resolves (mirrors tests/load.test.mjs)
const modules = [
    '../js/config.js', '../js/utils.js', '../js/state.js', '../js/audio.js',
    '../js/wakeword.js', '../js/stt.js', '../js/tts.js', '../js/memory.js',
    '../js/skillManager.js', '../js/skills/calculator.js', '../js/skills/websearch.js',
    '../js/skills/notes.js', '../js/skills/reminders.js', '../js/skills/datetime.js',
    '../js/skills/files.js', '../js/skills/reader.js', '../js/skills/memory.js',
    '../js/skills/vision.js', '../js/skills/browser.js', '../js/skills/dev.js', '../js/skills/iot.js',
    '../js/taskPlanner.js', '../js/permissions.js', '../js/agent.js',
    '../js/taskDashboard.js', '../js/settings.js', '../js/notifications.js',
    '../js/proactive.js', '../js/integrations.js',
    '../js/conversation.js', '../js/hud.js',
    '../js/auth.js', '../js/boot.js', '../js/app.js'
];
let imported = 0;
for (const f of modules) {
    try { await import(f); imported++; } catch (e) { console.log('  FAIL import', f, '->', e.message); }
}
check('all modules import cleanly', imported === modules.length);

// Initialization invariants (from the startup snapshot taken after import)
check('12 core skills registered at startup', initialSkillCount === 12);
check('all registered skills are valid manifests',
    skillManager.getSkills().every(s => skillManager.validateSkill(s).valid === true));
check('starts unauthenticated', initiallyUnauthenticated === false);
check('starts idle', initialAliceState === CONFIG.states.IDLE);
check('permission system starts with no pending prompt', permissionsIdleAtImport === true);

// Core application startup: fire the captured DOMContentLoaded the same way
// a real browser would, with screens present, and verify app.init() wires up.
const screens = {};
function makeScreen() {
    const added = [];
    const el = genericElement();
    el.classList = {
        add(c) { added.push(c); },
        remove() {}, toggle() {}, contains() { return false; }
    };
    el.added = added;
    return el;
}
screens['auth-screen'] = makeScreen();
screens['boot-screen'] = makeScreen();
screens['hud-screen'] = makeScreen();
getElementByIdOverride = (id) => screens[id] || genericElement();

let startupThrew = false;
try {
    for (const { type, fn } of domListeners) {
        if (type === 'DOMContentLoaded') fn();
    }
} catch (e) {
    startupThrew = true;
    console.log('  (startup threw:', e.message, ')');
}
await new Promise(r => realSetTimeout(r, 20));
check('core app startup does not throw', startupThrew === false);
check('startup shows the auth screen', state.get('currentScreen') === 'auth');
check('auth screen activated', screens['auth-screen'].added.includes('active'));

// Boot sequence: completes with every subsystem item marked online
const bootResult = await bootSequence.start(screens['boot-screen']);
check('boot sequence completes', bootResult === true);
const bootItems = state.get('bootItems');
check('boot initializes all subsystems',
    Array.isArray(bootItems) && bootItems.length === 15 && bootItems.every(i => i.status === 'complete'));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
