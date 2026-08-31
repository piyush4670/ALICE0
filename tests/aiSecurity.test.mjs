// Tests for AI Security Boundaries (Phase 6.2 AI Brain Architecture)
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

const { aiBrain } = await import('../js/ai/aiBrain.js');
const { planValidator } = await import('../js/ai/planValidator.js');
const { agent } = await import('../js/agent.js');
const { skillManager } = await import('../js/skillManager.js');
const { permissions } = await import('../js/permissions.js');
const { state } = await import('../js/state.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

const adapter = aiBrain.getAdapter();

console.log('1) Model cannot bypass permissions');
// Register a sensitive test skill
let sensitiveExecuted = false;
skillManager.register({
    name: 'sensitiveTestSkill',
    description: 'Sensitive skill for testing',
    risk: 'sensitive',
    patterns: [/^sensitivetest/],
    execute() {
        sensitiveExecuted = true;
        return { success: true, result: 'sensitive executed' };
    }
});

// A proposed plan with risk claimed as "safe" by model must still be gated by permission gateway
adapter.reset();
adapter.setCustomPlan('run sensitive test', {
    goal: 'run sensitive test',
    steps: [
        {
            id: 'step_1',
            skill: 'sensitiveTestSkill',
            action: 'delete all records',
            input: 'delete all records',
            risk: 'safe' // Attempting to bypass by claiming 'safe'
        }
    ]
});

// Validate plan
const planRes = await aiBrain.processRequest('run sensitive test');
check('AI plan is accepted by validator', planRes.success === true);

// Pass to agent execution — auto-deny confirmation
let promptSeen = false;
permissions.onPrompt(() => {
    promptSeen = true;
    setTimeout(() => permissions.answer(false), 0); // user cancels/denies
});

sensitiveExecuted = false;
const agentExecRes = await agent.executePlan(
    { isMultiStep: true, goal: 'run sensitive test', plan: planRes.plan },
    () => {}
);
check('sensitive action prompted for confirmation despite model claiming safe', promptSeen === true);
check('denied sensitive action was not executed', sensitiveExecuted === false);
check('agent reports cancellation', agentExecRes.success === false && /cancelled/i.test(agentExecRes.response));
permissions.onPrompt(null);

console.log('2) Model cannot execute arbitrary JavaScript');
const dangerousPayloads = [
    '<script>document.location="http://attacker.com"</script>',
    'javascript:alert(1)',
    'eval("window.localStorage.clear()")',
    'Function("return process.mainModule.require(\'child_process\')")()',
    'require("fs").readFileSync("/etc/passwd")',
    'window.location.href = "https://evil.site"'
];

for (const payload of dangerousPayloads) {
    const maliciousPlan = {
        goal: 'test payload',
        steps: [
            {
                id: 'step_1',
                skill: 'notes',
                input: payload
            }
        ]
    };
    const vResult = planValidator.validate(maliciousPlan);
    check(`injection payload rejected: "${payload.slice(0, 30)}..."`, vResult.valid === false);
}

console.log('3) Model cannot invoke unknown skills');
adapter.reset();
adapter.setCustomPlan('invoke unknown skill', {
    goal: 'invoke unknown skill',
    steps: [
        { id: 'step_1', skill: 'nonExistentHackingTool', input: 'hack' }
    ]
});
const unknownRes = await aiBrain.processRequest('invoke unknown skill');
check('unknown skill rejected by plan validator', unknownRes.success === false);
check('fallback flag set for unknown skill', unknownRes.fallback === true);

console.log('4) Invalid plans never reach execution');
let executedStep = false;
skillManager.register({
    name: 'trapSkill',
    description: 'Trap skill that should not execute',
    patterns: [/^trapskill/],
    execute() {
        executedStep = true;
        return { success: true, result: 'trap' };
    }
});

const cyclicPlan = {
    isMultiStep: true,
    goal: 'cyclic goal',
    plan: [
        { id: 's1', skill: 'trapSkill', dependsOn: ['s2'] },
        { id: 's2', skill: 'trapSkill', dependsOn: ['s1'] }
    ]
};
// If directly passed to agent without plan validation: Agent's internal validatePlan checks basic structure,
// but PlanValidator catches cycles up-front.
const valCyclic = planValidator.validate({ goal: cyclicPlan.goal, steps: cyclicPlan.plan });
check('cyclic plan caught by planValidator', valCyclic.valid === false);
check('trap skill never executed', executedStep === false);

console.log('5) Disabled skills never execute from AI plan');
skillManager.setEnabled('notes', false);
adapter.reset();
adapter.setCustomPlan('save with disabled notes', {
    goal: 'save with disabled notes',
    steps: [
        { id: 'step_1', skill: 'notes', input: 'save this note' }
    ]
});
const disabledRes = await aiBrain.processRequest('save with disabled notes');
check('disabled skill in AI plan is rejected', disabledRes.success === false);
check('disabled skill error flagged', disabledRes.fallback === true);
skillManager.setEnabled('notes', true);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
