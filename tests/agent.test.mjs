// Headless smoke test for Part 4 (run with node). Not part of the app.
globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};
globalThis.document = {
    createElement() {
        return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return null; } };
    },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; }
};
globalThis.Blob = class { constructor() {} };
globalThis.URL = { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} };

let failSearch = false;
globalThis.fetch = async (url) => {
    if (failSearch) throw new Error('network down');
    return {
        ok: true,
        json: async () => ({
            AbstractText: 'Quantum computing is a type of computation that uses quantum bits, or qubits, which can exist in superposition. This enables certain problems to be solved much faster than with classical computers.',
            Heading: 'Quantum computing',
            AbstractURL: 'https://en.wikipedia.org/wiki/Quantum_computing'
        })
    };
};

const { taskPlanner } = await import('../js/taskPlanner.js');
const { agent } = await import('../js/agent.js');
const { permissions } = await import('../js/permissions.js');
const { state } = await import('../js/state.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

console.log('1) Task planning');
let a = taskPlanner.analyze('research quantum computing, summarize the important information and create a document');
check('multi-step detected', a.isMultiStep === true);
check('3 steps planned', a.plan.length === 3);
check('step1 = research(websearch)', a.plan[0].skill === 'websearch' && a.plan[0].action === 'search');
check('step2 = summarize(core)', a.plan[1].skill === 'core' && a.plan[1].operation === 'summarize');
check('step3 = document(files)', a.plan[2].skill === 'files' && a.plan[2].action === 'create');
check('topic extracted', /quantum computing/i.test(a.plan[0].input));

let b = taskPlanner.analyze('what time is it');
check('single-step not misclassified', b.isMultiStep === false);

console.log('2) Agent execution loop (happy path)');
let spoken = [];
const res = await agent.process('research quantum computing, summarize the important information and create a document', { speak: t => spoken.push(t) });
check('agent returned a result', !!res);
check('agent success', res.success === true);
check('summary produced', !!res.context && !!res.context.summary && res.context.summary.result.length > 0);
check('document produced', !!res.context && !!res.context.document && res.context.document.filename === 'alice-research.txt');
check('spoke progress + report', spoken.length >= 2);
const task = state.getTask();
check('task status completed', task.status === 'completed');
check('all steps completed', task.plan.every(s => s.status === 'completed'));
check('progress 100', task.progress === 100);

console.log('3) Failure recovery');
failSearch = true;
const res2 = await agent.process('research quantum computing and summarize it', { speak: () => {} });
check('failed task reported as failure', res2.success === false);
check('clear error message', /could not be completed/i.test(res2.response));
const task2 = state.getTask();
check('task status failed', task2.status === 'failed');
failSearch = false;

console.log('4) Permissions / confirmation');
check('delete note = sensitive', permissions.evaluateStep({ skill: 'notes', action: 'delete my note', label: 'notes' }).requiresConfirmation === true);
check('research = safe', permissions.evaluateStep({ skill: 'websearch', action: 'search', label: 'research' }).requiresConfirmation === false);
check('forget = sensitive', permissions.evaluateStep({ skill: 'memory', action: 'forget my name', label: 'memory' }).requiresConfirmation === true);
check('send = sensitive', permissions.evaluateStep({ skill: 'files', action: 'send the file', label: 'files' }).requiresConfirmation === true);

// voice answer parsing
let p = permissions.requestConfirmation({ title: 't', message: 'm', action: 'a' });
check('pending while awaiting', permissions.hasPending() === true);
check('voice "approve" recognized', permissions.answerVoice('yes, approve') === true);
check('resolves to true', (await p) === true);

let p2 = permissions.requestConfirmation({ title: 't', message: 'm', action: 'a' });
check('voice "cancel" recognized', permissions.answerVoice('cancel') === false);
check('resolves to false', (await p2) === false);

let p3 = permissions.requestConfirmation({ title: 't', message: 'm', action: 'a' });
let ignored = permissions.answerVoice('what time is it');
check('unrelated voice not treated as answer', ignored === null);
check('still pending after unrelated speech', permissions.hasPending() === true);
permissions.answer(false);
await p3;

console.log('5) Task state merge (regression: confirmation must not wipe the plan)');
state.setTask({ goal: 'g', plan: [{ id: 'a', label: 'A' }], active: true });
state.setTask({ status: 'waiting_confirmation' });
let t5 = state.getTask();
check('setTask merges instead of replacing', t5.goal === 'g' && t5.plan.length === 1 && t5.status === 'waiting_confirmation');
state.resetTask();

console.log('6) Sensitive multi-step task (confirmation gate, auto-approved)');
permissions.onPrompt(() => setTimeout(() => permissions.answer(true), 0));
const res6 = await agent.process('search the web for cats then delete my note', { speak: () => {} });
const t6 = state.getTask();
check('sensitive step detected in plan', t6.plan.length === 2 && t6.plan[1].risk === 'sensitive');
// "delete my note" without a number/keyword can't resolve — agent must report clearly
check('reported clearly (success or failure)', !!res6 && typeof res6.response === 'string');
permissions.onPrompt(null);
state.resetTask();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
