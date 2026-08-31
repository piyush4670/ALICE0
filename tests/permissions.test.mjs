// Centralized permission enforcement tests (run with node).
//
// Pins the guarantees of the permission gateway:
//   - the ONE authoritative boundary lives in skillManager.executeByName(),
//     immediately before a skill executes
//   - safe actions run without any confirmation prompt
//   - sensitive actions prompt exactly ONCE (no duplicate dialogs — the old
//     double-prompt through conversation + skill self-confirmation is gone)
//   - denial and cancellation prevent execution and leave nothing changed
//   - a retried approved step does not re-prompt (approval memo)
//   - direct execution paths (process(), context flags) cannot bypass
//   - unknown / disabled skills are unavailable without prompting
//   - secrets in the request are scrubbed from the confirmation prompt
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

// window.open collector (browser skill side effects)
const opened = [];
globalThis.window.open = (url) => { opened.push(url); };

globalThis.document = {
    createElement() {
        return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, removeChild() {}, querySelector() { return null; } };
    },
    body: { appendChild() {}, removeChild() {}, innerText: 'hello page text' },
    title: 'Test Page',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};
globalThis.Blob = class { constructor() {} };
globalThis.URL = { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} };
globalThis.Image = class { set src(v) { this._src = v; } };
globalThis.FileReader = class { readAsDataURL() {} };
let failSearch = false;
globalThis.fetch = async () => {
    if (failSearch) throw new Error('network down');
    return { ok: true, json: async () => ({ AbstractText: 'Quantum computing uses qubits.', Heading: 'Quantum computing', AbstractURL: 'https://en.wikipedia.org/wiki/Quantum_computing' }) };
};

const { skillManager } = await import('../js/skillManager.js');
const { permissions } = await import('../js/permissions.js');
const { agent } = await import('../js/agent.js');
const { taskPlanner } = await import('../js/taskPlanner.js');
const { memory } = await import('../js/memory.js');
const { state } = await import('../js/state.js');
const { integrations } = await import('../js/integrations.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

// --- Confirmation harness --------------------------------------------------
// autoMode: 'approve' | 'deny' | null (manual — the test answers later)
let promptCount = 0;
let lastMeta = null;
let autoMode = 'approve';
permissions.onPrompt((meta) => {
    promptCount++;
    lastMeta = meta;
    if (autoMode === 'approve') setTimeout(() => permissions.answer(true), 0);
    else if (autoMode === 'deny') setTimeout(() => permissions.answer(false), 0);
});
const lightState = (id) => integrations.getDevice(id).state.on;
const noteGone = (kw) => memory.searchNotes(kw).length === 0;

console.log('1) Safe actions execute WITHOUT confirmation');

autoMode = null; // any unexpected prompt would hang — safe actions must not ask
const r11 = await skillManager.executeByName('datetime', 'what time is it');
check('datetime (safe) executes', r11.success === true && typeof r11.result === 'string');
const r12 = await skillManager.executeByName('iot', 'list my devices');
check('iot list (safeActions exemption) executes', r12.success === true && r12.result.includes('Desk Lamp'));
const r13 = await skillManager.executeByName('browser', 'read the current page');
check('browser read (safe) executes', r13.success === true && r13.result.includes('Test Page'));
check('zero prompts for safe actions', promptCount === 0);

// Agent happy path: multi-step plan of safe steps never prompts
const originalAnalyze = taskPlanner.analyze.bind(taskPlanner);
taskPlanner.analyze = () => ({
    isMultiStep: true, goal: 'research cats',
    plan: [{ id: 's1', label: 'Search the web', skill: 'websearch', operation: null, action: 'search', input: 'cats', contextKey: 'w', risk: 'safe' }]
});
const r14 = await agent.process('research cats', { speak: () => {} });
taskPlanner.analyze = originalAnalyze;
check('agent happy path completes', r14 && r14.success === true);
check('agent happy path prompted 0 times', promptCount === 0);
state.resetTask();

console.log('2) Sensitive actions request confirmation EXACTLY ONCE (with real effects)');

autoMode = 'approve';
promptCount = 0;
const r21 = await skillManager.executeByName('iot', 'turn on the desk lamp');
check('iot control approved → executed', r21.success === true);
check('desk lamp actually turned on', lightState('light-1') === true);
check('iot control prompted exactly once', promptCount === 1);

promptCount = 0;
const r22 = await skillManager.executeByName('browser', 'open the website example.com');
check('browser open approved → executed', r22.success === true);
check('window.open called with normalized url', opened[0] === 'https://example.com');
check('browser open prompted exactly once', promptCount === 1);

promptCount = 0;
const r23 = await skillManager.executeByName('dev', 'run the command npm install');
check('dev run approved → executed (simulated)', r23.success === true && /Simulated/i.test(r23.result));
check('dev run prompted exactly once (old code asked twice)', promptCount === 1);

promptCount = 0;
memory.addNote('Temp note', 'temporary content about Temp');
const r24 = await skillManager.executeByName('notes', 'delete my note about Temp');
check('note deletion approved → executed', r24.success === true);
check('note actually deleted', noteGone('Temp'));
check('note deletion prompted exactly once', promptCount === 1);

console.log('3) Denial prevents execution');

autoMode = 'deny';
promptCount = 0;
const before3 = lightState('light-2');
const r31 = await skillManager.executeByName('iot', 'turn on the room light');
check('denied → success false', r31.success === false);
check('denied → structured permission result', r31.permission && r31.permission.decision === 'denied' && r31.permission.skill === 'iot');
check('denied → cancelled flag set', r31.cancelled === true);
check('denied → structured message', typeof r31.error === 'string' && r31.error.length > 0);
check('device state unchanged after denial', lightState('light-2') === before3);
check('denial prompted exactly once', promptCount === 1);

console.log('4) Voice cancellation terminates safely');

autoMode = null; // manual: we answer by voice ourselves
promptCount = 0;
const before4 = lightState('light-1'); // still on from §2
const pending4 = skillManager.executeByName('iot', 'switch on the desk lamp');
await new Promise(r => setTimeout(r, 10)); // let the prompt open
check('prompt is pending', permissions.hasPending() === true);
const voiceAnswer = permissions.answerVoice('cancel');
const r4 = await pending4;
check('voice "cancel" recognized', voiceAnswer === false);
check('voice cancel → denied', r4.success === false && r4.permission.decision === 'denied');
check('no pending prompt remains', permissions.hasPending() === false);
check('device state unchanged after voice cancel', lightState('light-1') === before4);
check('voice cancel prompted exactly once', promptCount === 1);

console.log('5) Agent task: denial cancels the task; approval completes it');

// 5a — deny: task cancelled, note intact
autoMode = 'deny';
promptCount = 0;
memory.addNote('Keep note', 'please keep me');
taskPlanner.analyze = () => ({
    isMultiStep: true, goal: 'search then delete',
    plan: [
        { id: 's1', label: 'Search the web', skill: 'websearch', operation: null, action: 'search', input: 'cats', contextKey: 'w', risk: 'safe' },
        { id: 's2', label: 'Delete the note', skill: 'notes', operation: null, action: 'delete', input: 'delete my note about Keep', contextKey: 'n', risk: 'sensitive' }
    ]
});
const r5a = await agent.process('search the web for cats then delete my note about Keep', { speak: () => {} });
taskPlanner.analyze = originalAnalyze;
check('denied task → not successful', r5a && r5a.success === false);
check('denied task → cancelled message', /cancel/i.test(r5a.response));
check('note survives denial', noteGone('Keep') === false);
check('agent denial prompted exactly once', promptCount === 1);
const t5a = state.getTask();
check('task state ended cancelled', t5a.active === false && t5a.status === 'cancelled');
state.resetTask();

// 5b — approve: task completes, note deleted
autoMode = 'approve';
promptCount = 0;
taskPlanner.analyze = () => ({
    isMultiStep: true, goal: 'search then delete',
    plan: [
        { id: 's1', label: 'Search the web', skill: 'websearch', operation: null, action: 'search', input: 'cats', contextKey: 'w', risk: 'safe' },
        { id: 's2', label: 'Delete the note', skill: 'notes', operation: null, action: 'delete', input: 'delete my note about Keep', contextKey: 'n', risk: 'sensitive' }
    ]
});
const r5b = await agent.process('search the web for cats then delete my note about Keep', { speak: () => {} });
taskPlanner.analyze = originalAnalyze;
check('approved task completes', r5b && r5b.success === true);
check('note deleted after approval', noteGone('Keep') === true);
check('approved sensitive step prompted exactly once', promptCount === 1);
state.resetTask();

console.log('6) Retried approved step does NOT re-prompt (approval memo)');

let flakyCalls = 0;
skillManager.register({
    name: 'flaky', description: 'Test-only skill that always fails (sensitive)',
    risk: 'sensitive', patterns: [/^flaky/],
    execute() { flakyCalls++; return { success: false, error: 'flaky failed' }; }
});
autoMode = 'approve';
promptCount = 0;
taskPlanner.analyze = () => ({
    isMultiStep: true, goal: 'flaky goal',
    plan: [{ id: 's1', label: 'Flaky step', skill: 'flaky', operation: null, action: 'run', input: 'flaky attempt', contextKey: 'f', retries: 1 }]
});
const r6 = await agent.process('flaky goal', { speak: () => {} });
taskPlanner.analyze = originalAnalyze;
check('flaky skill executed twice (initial + 1 retry)', flakyCalls === 2);
check('retry prompted only ONCE (memo held the approval)', promptCount === 1);
check('flaky task failed cleanly', r6 && r6.success === false);
state.resetTask();

console.log('7) No bypass around the boundary');

autoMode = 'deny';
promptCount = 0;

// 7a — legacy process() path is gated too
memory.addNote('ProcessGuard note', 'guard content');
const r7a = await skillManager.process('delete my note about ProcessGuard');
check('process() path gated (denied)', r7a.success === false && r7a.permission && r7a.permission.decision === 'denied');
check('note survives process() denial', noteGone('ProcessGuard') === false);
check('process() denial prompted exactly once', promptCount === 1);

// 7b — context flags can never bypass (they are ignored by the gateway)
promptCount = 0;
memory.addNote('FlagGuard note', 'guard content');
const r7b = await skillManager.executeByName('notes', 'delete my note about FlagGuard', {
    preApproved: true, approved: true, skipConfirmation: true,
    permissions: 'granted', bypass: true, action: 'delete my note about FlagGuard'
});
check('context flags did NOT bypass the gate', r7b.success === false && r7b.permission.decision === 'denied');
check('note survives flagged-context denial', noteGone('FlagGuard') === false);
check('flagged context prompted exactly once', promptCount === 1);

// 7c — unknown skill → unavailable, no prompt
promptCount = 0;
const r7c = await skillManager.executeByName('does-not-exist', 'delete everything');
check('unknown skill → unavailable', r7c.success === false && r7c.permission && r7c.permission.decision === 'unavailable');
check('unknown skill did not prompt', promptCount === 0);

// 7d — disabled skill → unavailable, no prompt (disabled check precedes the gate)
promptCount = 0;
skillManager.setEnabled('vision', false);
const r7d = await skillManager.executeByName('vision', 'describe what you see');
skillManager.setEnabled('vision', true);
check('disabled skill → unavailable', r7d.success === false && r7d.permission && r7d.permission.decision === 'unavailable');
check('disabled skill did not prompt', promptCount === 0);

// 7e — the gateway is the boundary: bypassing skill self-execution is impossible
//      (skills no longer confirm; executeByName always gates)
promptCount = 0;
const r7e = await skillManager.executeByName('notes', 'delete my note about DirectGuard');
check('direct execution still gated', r7e.permission && r7e.permission.decision === 'denied');
check('no skill-side second prompt appeared', promptCount === 1);

console.log('8) Secrets are scrubbed from confirmation prompts');

autoMode = 'deny';
promptCount = 0;
const r8 = await skillManager.executeByName('memory', 'remember that my password is hunter2');
check('secret request prompted once', promptCount === 1);
check('denied → nothing stored', r8.success === false && memory.recall('password') === null);
check('prompt action has the secret redacted', /REDACTED/.test(lastMeta.action) && !/hunter2/.test(lastMeta.action));
check('prompt message has no secret', !/hunter2/.test(lastMeta.message) && !/hunter2/.test(lastMeta.title));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
