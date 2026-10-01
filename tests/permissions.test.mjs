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
const {
    permissions,
    APPROVE_PHRASES,
    CANCEL_PHRASES,
    normalizeConfirmationTranscript,
    parseVoiceConfirmation
} = await import('../js/permissions.js');
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

console.log('9) Voice confirmation transcript normalization & allowlist structure');

autoMode = null;
check('APPROVE_PHRASES is a frozen non-empty allowlist',
    Array.isArray(APPROVE_PHRASES) && APPROVE_PHRASES.length > 0 && Object.isFrozen(APPROVE_PHRASES));
check('CANCEL_PHRASES is a frozen non-empty allowlist',
    Array.isArray(CANCEL_PHRASES) && CANCEL_PHRASES.length > 0 && Object.isFrozen(CANCEL_PHRASES));
check('approve and cancel allowlists are strictly disjoint',
    APPROVE_PHRASES.every(p => !CANCEL_PHRASES.includes(p)));
check('normalizes whitespace, case, and ordinary punctuation',
    normalizeConfirmationTranscript('  YES, Approve!  ') === 'yes approve' &&
    normalizeConfirmationTranscript('...Go ahead...') === 'go ahead' &&
    normalizeConfirmationTranscript('"Confirm."') === 'confirm' &&
    normalizeConfirmationTranscript("'Approve'") === 'approve');
check('normalizes curly apostrophes safely',
    normalizeConfirmationTranscript('I don\u2019t approve!') === "i don't approve");
check('handles non-string and empty inputs safely',
    normalizeConfirmationTranscript('') === '' &&
    normalizeConfirmationTranscript('   ...  ') === '' &&
    normalizeConfirmationTranscript(null) === '' &&
    normalizeConfirmationTranscript(undefined) === '' &&
    normalizeConfirmationTranscript(42) === '');

console.log('10) Valid voice approvals resolve pending confirmation to true');

const VALID_APPROVALS = [
    'yes',
    'yeah',
    'yep',
    'approve',
    'approved',
    'i approve',
    'please approve',
    'yes, approve',
    'ok',
    'okay',
    'okie',
    'go ahead',
    'confirm',
    'confirmed',
    'proceed',
    'do it',
    'sure',
    'please do',
    'accepted',
    '  YES!  ',
    'Approve.',
    'Okay, go ahead!'
];
for (const phrase of VALID_APPROVALS) {
    const p = permissions.requestConfirmation({ title: 'Test', message: 'Confirm?', action: 'test approve' });
    const ans = permissions.answerVoice(phrase);
    const resolved = await p;
    check(`valid approval "${phrase}" → true`, ans === true && resolved === true && permissions.hasPending() === false);
}

console.log('11) Valid voice cancellations resolve pending confirmation to false');

const VALID_CANCELLATIONS = [
    'no',
    'nope',
    'cancel',
    'cancelled',
    'stop',
    'abort',
    "don't",
    'dont',
    'do not',
    'never mind',
    'hold on',
    'wait',
    'not now',
    'no thanks',
    'no thank you',
    'decline',
    'reject',
    'deny',
    'No, cancel!',
    '  Not now.  ',
    'Don\u2019t!'
];
for (const phrase of VALID_CANCELLATIONS) {
    const p = permissions.requestConfirmation({ title: 'Test', message: 'Confirm?', action: 'test cancel' });
    const ans = permissions.answerVoice(phrase);
    const resolved = await p;
    check(`valid cancellation "${phrase}" → false`, ans === false && resolved === false && permissions.hasPending() === false);
}

console.log('12) Accidental substrings must NOT approve and leave confirmation pending');

const ACCIDENTAL_SUBSTRINGS = [
    'yesterday',
    'yesteryear',
    'eyes',
    'okayish',
    'token',
    'book',
    'lookup',
    'karaoke',
    'insure',
    'unsure',
    'measure',
    'treasure',
    'disapprove',
    'unapproved',
    'unconfirmed'
];
{
    const p = permissions.requestConfirmation({ title: 'Test', message: 'Confirm?', action: 'substring guard' });
    for (const word of ACCIDENTAL_SUBSTRINGS) {
        const ans = permissions.answerVoice(word);
        check(`substring "${word}" does not approve and stays pending`,
            ans === null && permissions.hasPending() === true);
    }
    permissions.answer(false);
    check('substring guard prompt cleanly cancelled afterwards', (await p) === false);
}

console.log('13) Negated phrases must NOT approve');

const NEGATED_PHRASES = [
    "I don't approve",
    'I don\u2019t approve',
    'do not approve',
    "don't approve",
    'not approved',
    'never approve',
    'I do not confirm',
    "don't confirm",
    'do not proceed',
    "don't go ahead",
    "don't do it",
    'do not do it',
    'not yes',
    'not ok',
    'not okay',
    'not sure',
    "I'm not sure",
    "can't approve",
    "won't approve"
];
{
    const p = permissions.requestConfirmation({ title: 'Test', message: 'Confirm?', action: 'negation guard' });
    for (const phrase of NEGATED_PHRASES) {
        const ans = permissions.answerVoice(phrase);
        check(`negation "${phrase}" never approves and leaves confirmation pending`,
            ans === null && permissions.hasPending() === true);
    }
    // Verify "not now" specifically cancels rather than approving
    const notNowAns = permissions.answerVoice('not now');
    const resolved = await p;
    check('"not now" cancels pending confirmation and never approves',
        notNowAns === false && resolved === false && permissions.hasPending() === false);
}

console.log('14) Contradictory phrases must NOT approve and leave confirmation pending');

const CONTRADICTORY_PHRASES = [
    'yes no',
    'yes or no',
    'no or yes',
    'yes, no',
    'approve cancel',
    'approve or cancel',
    'yes, wait',
    'yes wait',
    'okay stop',
    'sure, cancel',
    'go ahead, wait',
    'confirm no',
    'yes, not now',
    'ok, never mind'
];
{
    const p = permissions.requestConfirmation({ title: 'Test', message: 'Confirm?', action: 'contradiction guard' });
    for (const phrase of CONTRADICTORY_PHRASES) {
        const ans = permissions.answerVoice(phrase);
        check(`contradictory "${phrase}" does not approve and stays pending`,
            ans === null && permissions.hasPending() === true);
    }
    permissions.answer(false);
    await p;
}

console.log('15) Ambiguous and unrelated transcripts must NOT approve');

const AMBIGUOUS_AND_UNRELATED = [
    'maybe',
    'perhaps',
    'I think so',
    'probably',
    'I guess',
    'hmm',
    'uh',
    'whatever',
    'yes?',
    'approve?',
    'should I approve?',
    'what time is it',
    'yes I went to the store yesterday',
    'can you tell me if everything is ok',
    'make sure my notes are saved',
    'please do the calculation for 2 plus 2',
    'go ahead and tell me the weather',
    'confirm what this action does before anything else',
    '',
    '   ',
    '...'
];
{
    memory.addNote('VoiceSafetyNote', 'important note that must not be deleted by unrelated speech');
    const pendingExec = skillManager.executeByName('notes', 'delete my note about VoiceSafetyNote');
    await new Promise(r => setTimeout(r, 10));
    check('sensitive note deletion is awaiting confirmation', permissions.hasPending() === true);

    for (const transcript of AMBIGUOUS_AND_UNRELATED) {
        const ans = permissions.answerVoice(transcript);
        check(`ambiguous/unrelated "${transcript}" → null and stays pending`,
            ans === null && permissions.hasPending() === true);
    }
    check('note still exists while confirmation remains pending', noteGone('VoiceSafetyNote') === false);

    // Explicitly cancel to finish the pending execution
    const cancelAns = permissions.answerVoice('cancel');
    const execResult = await pendingExec;
    check('explicit cancel resolves the pending execution as denied',
        cancelAns === false && execResult.success === false && execResult.permission.decision === 'denied');
    check('note still intact after cancellation', noteGone('VoiceSafetyNote') === false);
}

console.log('16) Late speech cannot approve an already-cancelled or different action');

{
    // 16a — Late speech after an action is already cancelled
    memory.addNote('LateSpeechNoteA', 'keep safe A');
    const execA = skillManager.executeByName('notes', 'delete my note about LateSpeechNoteA');
    await new Promise(r => setTimeout(r, 10));
    const metaA = permissions.getPendingMeta();
    check('prompt A opened', permissions.hasPending() === true && metaA !== null);

    // User cancels action A
    permissions.answerVoice('cancel');
    const resA = await execA;
    check('action A was denied', resA.success === false && resA.permission.decision === 'denied');

    // Late "approve" transcript arrives after cancellation
    const lateAfterCancel = permissions.answerVoice('approve');
    const lateWithIdAfterCancel = permissions.answerVoice('yes', metaA.id);
    check('late speech after cancellation returns null',
        lateAfterCancel === null && lateWithIdAfterCancel === null && permissions.hasPending() === false);
    check('Note A still intact after late approval attempt', noteGone('LateSpeechNoteA') === false);

    // Retrying action A must still require confirmation (late speech did not populate approval memo)
    let reprompted = false;
    const retryA = skillManager.executeByName('notes', 'delete my note about LateSpeechNoteA');
    await new Promise(r => setTimeout(r, 10));
    reprompted = permissions.hasPending();
    permissions.answer(false);
    await retryA;
    check('cancelled action was not memoized as approved after late speech', reprompted === true);

    // 16b — Late speech for prompt 1 cannot approve superseding prompt 2
    const pFirst = permissions.requestConfirmation({ title: 'First', message: 'First action', action: 'delete note 1' });
    const firstMeta = permissions.getPendingMeta();
    const pSecond = permissions.requestConfirmation({ title: 'Second', message: 'Second action', action: 'delete note 2' });
    const secondMeta = permissions.getPendingMeta();

    check('first prompt resolved to false when superseded', (await pFirst) === false);
    check('second prompt is now pending with a distinct id',
        permissions.hasPending() === true && secondMeta.id !== firstMeta.id);

    // Late speech tied to firstMeta (by id, meta object, or action) must NOT approve pSecond
    const lateById = permissions.answerVoice('approve', firstMeta.id);
    const lateByMeta = permissions.answerVoice('yes', firstMeta);
    const lateByAction = permissions.answerVoice('confirm', firstMeta.action);
    check('late speech bound to first prompt rejected while second prompt is pending',
        lateById === null && lateByMeta === null && lateByAction === null);
    check('second prompt remains pending after late speech from first prompt',
        permissions.hasPending() === true && permissions.getPendingMeta().id === secondMeta.id);

    // Second prompt can still be answered with its own matching id
    const validSecondCancel = permissions.answerVoice('cancel', secondMeta.id);
    check('second prompt resolves normally with its own id',
        validSecondCancel === false && (await pSecond) === false && permissions.hasPending() === false);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
