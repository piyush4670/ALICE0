// Tests for AI Fallback Behavior (Phase 6.2 AI Brain Architecture)
globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: {
        cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; }
    },
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined,
    AudioContext: undefined,
    webkitAudioContext: undefined
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
        this.text = text;
    }
};
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: undefined, permissions: undefined }, configurable: true });
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

let failFetch = false;
globalThis.fetch = async (url) => {
    if (failFetch) throw new Error('network down');
    return {
        ok: true,
        json: async () => ({
            AbstractText: 'Quantum computing is computation using quantum mechanical phenomena.',
            Heading: 'Quantum computing',
            AbstractURL: 'https://en.wikipedia.org/wiki/Quantum_computing'
        })
    };
};

const { conversation } = await import('../js/conversation.js');
const { aiBrain } = await import('../js/ai/aiBrain.js');
const { state } = await import('../js/state.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

const adapter = aiBrain.getAdapter();

console.log('1) AI Failure → Deterministic Planner Fallback');
adapter.reset();
adapter.setFailure(true, new Error('Simulated LLM service 503 error'));

// When conversation processes a multi-step request and AI fails,
// it falls back to the deterministic planner and completes the task!
state.resetTask();
const res1 = await conversation._processWithSkills('research quantum computing, summarize the important information and create a document');
check('request succeeded via fallback', res1 && res1.skill === 'agent');
check('response generated', typeof res1.response === 'string' && res1.response.length > 0);
const task1 = state.getTask();
check('task completed via deterministic fallback', task1.status === 'completed');
check('progress reached 100%', task1.progress === 100);
adapter.reset();

console.log('2) Invalid AI Plan → Deterministic Planner Fallback');
adapter.reset();
// Mock AI generates an invalid plan with cyclic dependencies
adapter.setCustomPlan('research quantum computing', {
    goal: 'research quantum computing',
    steps: [
        { id: 'step_1', skill: 'websearch', dependsOn: ['step_2'] },
        { id: 'step_2', skill: 'files', dependsOn: ['step_1'] }
    ]
});

state.resetTask();
const res2 = await conversation._processWithSkills('research quantum computing, summarize the important information and create a document');
check('request with invalid AI plan falls back to deterministic planner', res2 && res2.skill === 'agent');
check('fallback completed successfully', res2.response.includes('Done'));
const task2 = state.getTask();
check('task completed without getting stuck', task2.status === 'completed');
adapter.reset();

console.log('3) AI Brain Disabled → Deterministic Planner Fallback');
aiBrain.setEnabled(false);
state.resetTask();
const res3 = await conversation._processWithSkills('research quantum computing, summarize the important information and create a document');
check('disabled AI falls back cleanly to deterministic planner', res3 && res3.skill === 'agent');
check('task status completed', state.getTask().status === 'completed');
aiBrain.setEnabled(true);

console.log('4) Both AI Brain & Deterministic Planner Failure → Safe Error');
adapter.reset();
adapter.setFailure(true, new Error('AI Down'));
failFetch = true; // causes websearch to fail

state.resetTask();
const res4 = await conversation._processWithSkills('research quantum computing and summarize it');
check('double failure handled safely', res4 && typeof res4.response === 'string');
check('error message returned safely without throwing', /could not be completed|network down/i.test(res4.response));
check('task marked failed in state', state.getTask().status === 'failed');

failFetch = false;
adapter.reset();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
