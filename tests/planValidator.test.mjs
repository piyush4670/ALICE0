// Tests for Plan Validator (Phase 6.2 AI Brain Architecture)
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

const { planValidator } = await import('../js/ai/planValidator.js');
const { skillManager } = await import('../js/skillManager.js');
const { CONFIG } = await import('../js/config.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

console.log('1) Valid Plan Validation');
const validPlan = {
    goal: 'research quantum computing and save notes',
    steps: [
        {
            id: 'step_1',
            skill: 'websearch',
            action: 'search',
            input: 'quantum computing',
            contextKey: 'research',
            dependsOn: []
        },
        {
            id: 'step_2',
            skill: 'core',
            operation: 'summarize',
            input: '',
            inputSource: 'research',
            contextKey: 'summary',
            dependsOn: ['step_1']
        },
        {
            id: 'step_3',
            skill: 'notes',
            action: 'create',
            input: '',
            inputSource: 'summary',
            contextKey: 'note',
            dependsOn: ['step_2']
        }
    ]
};
const resValid = planValidator.validate(validPlan);
check('valid plan passes validation', resValid.valid === true);
check('valid plan produces normalized steps', Array.isArray(resValid.normalizedPlan) && resValid.normalizedPlan.length === 3);
check('normalized step carries correct skill', resValid.normalizedPlan[0].skill === 'websearch');
check('normalized step carries correct dependencies', resValid.normalizedPlan[1].dependsOn[0] === 'step_1');
check('no errors on valid plan', resValid.errors.length === 0);

console.log('2) Invalid Schema Rejection');
check('null plan rejected', planValidator.validate(null).valid === false);
check('empty object rejected', planValidator.validate({}).valid === false);
check('missing goal rejected', planValidator.validate({ steps: [{ id: 's1', skill: 'notes' }] }).valid === false);
check('empty goal rejected', planValidator.validate({ goal: '   ', steps: [{ id: 's1', skill: 'notes' }] }).valid === false);
check('non-string goal rejected', planValidator.validate({ goal: 12345, steps: [{ id: 's1', skill: 'notes' }] }).valid === false);
check('missing steps rejected', planValidator.validate({ goal: 'do task' }).valid === false);
check('empty steps array rejected', planValidator.validate({ goal: 'do task', steps: [] }).valid === false);
check('non-array steps rejected', planValidator.validate({ goal: 'do task', steps: 'step1' }).valid === false);

console.log('3) Duplicate Step IDs');
const dupPlan = {
    goal: 'duplicate steps',
    steps: [
        { id: 'step_same', skill: 'calculator', input: '2+2' },
        { id: 'step_same', skill: 'notes', input: 'save result' }
    ]
};
const resDup = planValidator.validate(dupPlan);
check('duplicate step IDs rejected', resDup.valid === false);
check('duplicate step ID error message clear', resDup.errors.some(e => /duplicate/i.test(e) && /step_same/.test(e)));

console.log('4) Invalid Dependency References');
const invalidDepPlan = {
    goal: 'bad dependency',
    steps: [
        { id: 'step_1', skill: 'websearch', input: 'cats', dependsOn: [] },
        { id: 'step_2', skill: 'notes', input: 'save', dependsOn: ['non_existent_step'] }
    ]
};
const resInvalidDep = planValidator.validate(invalidDepPlan);
check('unknown dependency step ID rejected', resInvalidDep.valid === false);
check('unknown dependency error reported', resInvalidDep.errors.some(e => /depends on unknown step/i.test(e)));

const selfDepPlan = {
    goal: 'self dependency',
    steps: [
        { id: 'step_self', skill: 'notes', input: 'self', dependsOn: ['step_self'] }
    ]
};
const resSelfDep = planValidator.validate(selfDepPlan);
check('self-referencing dependency rejected', resSelfDep.valid === false);
check('self dependency error reported', resSelfDep.errors.some(e => /cannot depend on itself/i.test(e)));

console.log('5) Dependency Cycles (DAG Validation)');
const directCyclePlan = {
    goal: 'direct cycle',
    steps: [
        { id: 'step_a', skill: 'websearch', input: 'a', dependsOn: ['step_b'] },
        { id: 'step_b', skill: 'notes', input: 'b', dependsOn: ['step_a'] }
    ]
};
const resDirectCycle = planValidator.validate(directCyclePlan);
check('2-step circular dependency rejected', resDirectCycle.valid === false);
check('cycle error identified', resDirectCycle.errors.some(e => /circular dependency/i.test(e)));

const indirectCyclePlan = {
    goal: 'indirect cycle',
    steps: [
        { id: 'step_1', skill: 'websearch', input: '1', dependsOn: ['step_3'] },
        { id: 'step_2', skill: 'core', operation: 'summarize', dependsOn: ['step_1'] },
        { id: 'step_3', skill: 'notes', input: '3', dependsOn: ['step_2'] }
    ]
};
const resIndirectCycle = planValidator.validate(indirectCyclePlan);
check('3-step circular dependency rejected', resIndirectCycle.valid === false);
check('indirect cycle error identified', resIndirectCycle.errors.some(e => /circular dependency/i.test(e)));

console.log('6) Step Limits (CONFIG.agent.maxSteps)');
const maxSteps = CONFIG.agent.maxSteps || 8;
const oversizedSteps = Array.from({ length: maxSteps + 1 }, (_, i) => ({
    id: `step_${i + 1}`,
    skill: 'calculator',
    input: `${i} + 1`
}));
const resOversized = planValidator.validate({ goal: 'too many steps', steps: oversizedSteps });
check('oversized plan exceeds maxSteps limit is rejected', resOversized.valid === false);
check('step limit error message clear', resOversized.errors.some(e => /exceeds maximum limit/i.test(e)));

const exactSteps = Array.from({ length: maxSteps }, (_, i) => ({
    id: `step_${i + 1}`,
    skill: 'calculator',
    input: `${i} + 1`
}));
const resExact = planValidator.validate({ goal: 'exact max steps', steps: exactSteps });
check(`plan with exact maxSteps (${maxSteps}) is accepted`, resExact.valid === true);

console.log('7) Valid and Unknown Skill Names');
const unknownSkillPlan = {
    goal: 'unknown skill',
    steps: [
        { id: 'step_1', skill: 'unregistered_hack_tool', input: 'run' }
    ]
};
const resUnknownSkill = planValidator.validate(unknownSkillPlan);
check('unknown skill rejected', resUnknownSkill.valid === false);
check('unknown skill error reported', resUnknownSkill.errors.some(e => /unknown skill/i.test(e)));

console.log('8) Disabled Skills');
skillManager.setEnabled('calculator', false);
const disabledSkillPlan = {
    goal: 'calculate with disabled skill',
    steps: [
        { id: 'step_1', skill: 'calculator', input: '5 * 5' }
    ]
};
const resDisabledSkill = planValidator.validate(disabledSkillPlan);
check('disabled skill rejected by plan validator', resDisabledSkill.valid === false);
check('disabled skill error reported', resDisabledSkill.errors.some(e => /currently disabled/i.test(e)));
skillManager.setEnabled('calculator', true);

console.log('9) Malformed Inputs');
const malformedInputPlan = {
    goal: 'malformed input',
    steps: [
        { id: 'step_1', skill: 'notes', input: 12345 } // non-string, non-object
    ]
};
const resMalformedInput = planValidator.validate(malformedInputPlan);
check('non-string, non-object input rejected', resMalformedInput.valid === false);
check('malformed input error reported', resMalformedInput.errors.some(e => /invalid input type/i.test(e)));

console.log('10) Executable Code Injection Attempts');
const scriptInjectionPlan = {
    goal: '<script>alert("hacked")</script>',
    steps: [
        { id: 'step_1', skill: 'notes', input: 'test' }
    ]
};
const resScriptInj = planValidator.validate(scriptInjectionPlan);
check('script tag in goal rejected', resScriptInj.valid === false);
check('executable code error reported', resScriptInj.errors.some(e => /executable code or unsafe/i.test(e)));

const evalInjectionPlan = {
    goal: 'execute eval',
    steps: [
        { id: 'step_1', skill: 'notes', input: 'eval("window.location = \'evil.com\'")' }
    ]
};
const resEvalInj = planValidator.validate(evalInjectionPlan);
check('eval injection in step input rejected', resEvalInj.valid === false);

const protoTamperingPlan = {
    goal: 'prototype pollution attempt',
    steps: [
        { id: 'step_1', skill: 'notes', input: 'harmless', __proto__: { admin: true } }
    ]
};
const resProto = planValidator.validate(protoTamperingPlan);
check('prototype pollution attempt rejected', resProto.valid === false);

const fnInstancePlan = {
    goal: 'function instance injection',
    steps: [
        { id: 'step_1', skill: 'notes', input: () => 'malicious code' }
    ]
};
const resFn = planValidator.validate(fnInstancePlan);
check('function instance inside step rejected', resFn.valid === false);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
