// Regression tests for agent/planner execution boundaries (run with node).
//
// Pins the hardening guarantees:
//   - CONFIG.agent.maxSteps is enforced for EVERY generated plan (planner
//     refuses oversized plans) AND as a hard execution boundary inside the
//     agent (malformed/oversized plans cannot bypass it)
//   - retries are capped by CONFIG.agent.maxRetries and never execute
//     unrelated steps
//   - invalid / disabled skills are never executed
//   - unexpected exceptions from skills are normalized into safe results
//   - failed steps terminate cleanly; the blackboard mechanism is preserved
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
const { skillManager } = await import('../js/skillManager.js');
const { state } = await import('../js/state.js');
const { CONFIG } = await import('../js/config.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

const MAX = CONFIG.agent.maxSteps;
const MAXR = CONFIG.agent.maxRetries;

// --- Test-only skills (registered through the public plugin API) ----------
let boomCount = 0, throwCount = 0, asyncThrowCount = 0, okCount = 0;
skillManager.register({
    name: 'okskill', description: 'Test-only skill that succeeds', patterns: [/^okskill/],
    execute() { okCount++; return { success: true, result: 'ok' }; }
});
skillManager.register({
    name: 'boom', description: 'Test-only skill that always fails', patterns: [/^boom/],
    execute() { boomCount++; return { success: false, error: 'boom failed' }; }
});
skillManager.register({
    name: 'thrower', description: 'Test-only skill that throws synchronously', patterns: [/^thrower/],
    execute() { throwCount++; throw new Error('kaboom'); }
});
skillManager.register({
    name: 'asyncThrower', description: 'Test-only skill whose promise rejects', patterns: [/^asyncThrower/],
    async execute() { asyncThrowCount++; throw new Error('async kaboom'); }
});
skillManager.register({
    name: 'undefinedReturner', description: 'Test-only skill returning no result object', patterns: [/^undefinedReturner/],
    execute() { return undefined; }
});
skillManager.register({
    name: 'slowok', description: 'Test-only skill that succeeds slowly', patterns: [/^slowok/],
    async execute() { await new Promise(r => setTimeout(r, 150)); return { success: true, result: 'slow ok' }; }
});

// --- Helpers ---------------------------------------------------------------
// Inject a crafted plan by shadowing the planner's analyze() (restored after
// each use) so the agent's own boundaries can be tested in isolation.
const originalAnalyze = taskPlanner.analyze.bind(taskPlanner);
function injectPlan(plan, goal = 'injected goal') {
    taskPlanner.analyze = () => ({ isMultiStep: true, goal, plan });
}
function restorePlanner() {
    taskPlanner.analyze = originalAnalyze;
}

const step = (over = {}) => ({
    id: 'step',
    label: 'Step',
    skill: 'okskill',
    operation: null,
    action: 'run',
    input: 'okskill',
    inputSource: null,
    contextKey: 'k0',
    risk: 'safe',
    retries: 0,
    alternatives: [],
    filename: null,
    ...over
});

const clause = (i) => `calculate ${i + 1} plus ${i + 1}`;
const command = (n) => Array.from({ length: n }, (_, i) => clause(i)).join(' and then ');

console.log('1) Planner enforces CONFIG.agent.maxSteps for every generated plan');
const atLimit = taskPlanner.analyze(command(MAX));
check(`plan of exactly maxSteps (${MAX}) is emitted`, atLimit.isMultiStep === true && atLimit.plan.length === MAX);
const overLimit = taskPlanner.analyze(command(MAX + 1));
check(`plan longer than maxSteps (${MAX + 1}) is refused`, overLimit.isMultiStep === false && overLimit.plan.length === 0);
const underLimit = taskPlanner.analyze(command(2));
check('plan under the limit is still emitted', underLimit.isMultiStep === true && underLimit.plan.length === 2);
check('refused plan produces no agent task', (await agent.process(command(MAX + 1), { speak: () => {} })) === null);

console.log('2) Agent executes a plan of exactly maxSteps');
state.resetTask();
const resExact = await agent.process(command(MAX), { speak: () => {} });
check('task with exactly maxSteps steps succeeds', resExact.success === true);
const tExact = state.getTask();
check('all steps completed', tExact.plan.length === MAX && tExact.plan.every(s => s.status === 'completed'));
check('progress reached 100', tExact.progress === 100 && tExact.status === 'completed');

console.log('3) Hard execution boundary: oversized plan cannot bypass the limit');
state.resetTask();
okCount = 0;
injectPlan(Array.from({ length: MAX + 4 }, (_, i) => step({ id: `s${i}`, label: `Oversized step ${i + 1}`, contextKey: `k${i}` })));
const resOver = await agent.process('oversized plan goal', { speak: () => {} });
check('oversized plan rejected before execution', resOver === null);
const tOver = state.getTask();
check('no task state was started', tOver.active === false && tOver.status === 'idle');
check('no skill was executed', okCount === 0);
restorePlanner();

console.log('4) Malformed plans are rejected before execution');
state.resetTask();
okCount = 0;
injectPlan('not-an-array');
check('non-array plan refused', (await agent.process('malformed 1', { speak: () => {} })) === null);
injectPlan([step(), null]);
check('plan containing a null step refused', (await agent.process('malformed 2', { speak: () => {} })) === null);
injectPlan([{ label: 'No skill bound', action: 'run' }]);
check('step without a skill binding refused', (await agent.process('malformed 3', { speak: () => {} })) === null);
injectPlan([]);
check('empty plan refused', (await agent.process('malformed 4', { speak: () => {} })) === null);
check('nothing executed from malformed plans', okCount === 0);
check('no task state started by malformed plans', state.getTask().status === 'idle');
restorePlanner();

console.log('5) Retry limit is capped by CONFIG.agent.maxRetries');
state.resetTask();
boomCount = 0; okCount = 0;
injectPlan([
    step({ id: 'b', label: 'Failing step', skill: 'boom', action: 'boom', input: 'boom', contextKey: 'b', retries: 99 }),
    step({ id: 'o', label: 'Follow-up step', contextKey: 'o' })
]);
const resRetry = await agent.process('retry limit goal', { speak: () => {} });
check('task fails when retries are exhausted', resRetry.success === false);
check(`retries capped at maxRetries (${MAXR})`, boomCount === 1 + MAXR);
check('retrying never executed the unrelated next step', okCount === 0);
check('task marked failed', state.getTask().status === 'failed');
check('failure reported clearly', /could not be completed/.test(resRetry.response));
restorePlanner();

console.log('6) Invalid skill names cannot be executed');
state.resetTask();
okCount = 0;
injectPlan([
    step({ skill: 'does-not-exist', label: 'Missing skill step', contextKey: 'm' }),
    step({ label: 'Follow-up step', contextKey: 'o2' })
]);
const resInvalid = await agent.process('invalid skill goal', { speak: () => {} });
check('invalid skill fails the task', resInvalid.success === false);
check('invalid skill reported clearly', /not available/.test(resInvalid.response));
check('later steps never executed', okCount === 0);
restorePlanner();

console.log('7) Disabled skills cannot be executed');
state.resetTask();
skillManager.setEnabled('websearch', false);
injectPlan([step({ skill: 'websearch', action: 'search', input: 'cats', label: 'Lookup topic', contextKey: 'w' })]);
const resDisabled = await agent.process('disabled skill goal', { speak: () => {} });
check('disabled skill fails the task', resDisabled.success === false);
check('disabled skill reported clearly', /disabled/i.test(resDisabled.response));
skillManager.setEnabled('websearch', true);
restorePlanner();

console.log('8) Failed tool terminates the task cleanly');
state.resetTask();
failSearch = true;
const resFail = await agent.process('research quantum computing and summarize it', { speak: () => {} });
check('failed tool fails the task', resFail.success === false);
check('clear failure message', /could not be completed/.test(resFail.response));
check('task status failed', state.getTask().status === 'failed');
failSearch = false;

console.log('9) Unexpected exceptions are normalized into safe results');
state.resetTask();
throwCount = 0; okCount = 0;
injectPlan([
    step({ skill: 'thrower', label: 'Throwing step', action: 'thrower', input: 'thrower', contextKey: 't', retries: 1 }),
    step({ label: 'Follow-up step', contextKey: 'o3' })
]);
const resThrow = await agent.process('synchronous throw goal', { speak: () => {} });
check('synchronous exception becomes a safe failure result', resThrow.success === false && typeof resThrow.response === 'string');
check('exception message surfaced safely', /kaboom/.test(resThrow.response));
check('throwing skill attempted within the retry cap', throwCount === 1 + Math.min(1, MAXR));
check('next step not executed after the exception', okCount === 0);
restorePlanner();

state.resetTask();
asyncThrowCount = 0;
injectPlan([step({ skill: 'asyncThrower', label: 'Async throwing step', action: 'asyncThrower', input: 'asyncThrower', contextKey: 'a', retries: 0 })]);
const resAsyncThrow = await agent.process('asynchronous throw goal', { speak: () => {} });
check('rejected promise becomes a safe failure result', resAsyncThrow.success === false && /async kaboom/.test(resAsyncThrow.response));
restorePlanner();

state.resetTask();
injectPlan([step({ skill: 'undefinedReturner', label: 'Empty result step', action: 'undefinedReturner', input: 'undefinedReturner', contextKey: 'u' })]);
const resUndef = await agent.process('empty result goal', { speak: () => {} });
check('non-object skill result normalized into a safe failure', resUndef.success === false && typeof resUndef.response === 'string');
restorePlanner();

console.log('10) Successful multi-step execution preserves the blackboard');
state.resetTask();
const resOk = await agent.process('research quantum computing, summarize the important information and create a document', { speak: () => {} });
check('multi-step task succeeds', resOk.success === true);
check('blackboard kept the research result', !!resOk.context && !!resOk.context.research && resOk.context.research.success === true);
check('blackboard kept the summary', !!resOk.context.summary && resOk.context.summary.result.length > 0);
check('blackboard kept the document', !!resOk.context.document && resOk.context.document.filename === 'alice-research.txt');
const tOk = state.getTask();
check('task completed at 100%', tOk.status === 'completed' && tOk.progress === 100);

console.log('11) Failed multi-step execution stops before later steps');
state.resetTask();
failSearch = true;
const resFailMulti = await agent.process('research quantum computing, summarize the important information and create a document', { speak: () => {} });
const tFM = state.getTask();
check('multi-step task fails on tool failure', resFailMulti.success === false);
check('failed step marked failed', tFM.plan[0].status === 'failed');
check('subsequent steps never executed', tFM.plan[1].status === 'pending' && tFM.plan[2].status === 'pending');
check('task not left active', tFM.active === false);
failSearch = false;

console.log('12) Execution terminates cleanly and the agent recovers');
check('agent state returned to idle after failure', state.get('aliceState') === 'IDLE');
state.resetTask();
const resAfter = await agent.process('research quantum computing and summarize it', { speak: () => {} });
check('agent accepts a new task after termination', resAfter.success === true);
check('new task completes', state.getTask().status === 'completed');

console.log('13) Re-entrant requests are declined while a task runs');
state.resetTask();
injectPlan([
    step({ skill: 'slowok', label: 'Slow step', action: 'slowok', input: 'slowok', contextKey: 's' }),
    step({ label: 'Fast step', contextKey: 's2' })
]);
const first = agent.process('first task', { speak: () => {} });
const second = await agent.process('second task', { speak: () => {} });
check('re-entrant request declined while running', second === null);
const firstResult = await first;
check('in-flight task completes undisturbed', firstResult.success === true);
restorePlanner();

console.log('14) Responses stay user-facing (no internals leaked)');
const failureResponses = [resRetry, resInvalid, resDisabled, resThrow, resAsyncThrow, resUndef, resFail, resFailMulti];
check('all failure responses are strings', failureResponses.every(r => typeof r.response === 'string' && r.response.length > 0));
check('no internal object dumps in responses', failureResponses.every(r => !r.response.includes('[object Object]')));
check('no leaked internal identifiers in responses', failureResponses.every(r => !/\bundefined\b|\bnull\b/.test(r.response)));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
