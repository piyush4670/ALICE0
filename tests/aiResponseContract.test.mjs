// Tests for Phase 6.4 — AI Response Contract Alignment.
// ------------------------------------------------------------------
// The AI Brain accepts exactly two JSON shapes from a model:
//
//   1. { "response": "..." }                          → direct answer
//   2. { "goal": "...", "steps": [ { "id", "skill", "input" } ] }
//
// Because the local gateway puts every non-text response format into
// provider JSON mode, the prompt built by ContextBuilder must state that
// contract explicitly. These tests prove:
//
//   1. The generated prompt contains the explicit response contract.
//   2. A direct informational request can be represented as {response: ...}
//      and is accepted end-to-end (no fallback).
//   3. An actionable request can be represented as {goal, steps} and is
//      validated/normalized exactly like any other model plan.
//   4. The prompt explicitly prohibits Markdown / code fences. This is a
//      PROMPT instruction: the existing parser still tolerates a fenced
//      block (pre-existing behaviour, deliberately unchanged), so that is
//      documented as tolerance and never claimed as a rejection.
//   5. The security boundary is unchanged: malformed, unknown-skill and
//      code-injection output is still rejected, and the skill named in the
//      contract's example is genuinely registered (proven from real tool
//      discovery / skillManager data).
//
//      Regarding an object carrying BOTH forms, two claims are kept apart:
//      the PROMPT forbids emitting both, while at RUNTIME AIBrain is not a
//      structural exclusivity enforcer — it checks `steps` first, so such
//      an object is handled as a plan whenever that plan passes
//      PlanValidator. The extra `response` field is never used as the
//      answer, and the ambiguous shape grants no bypass of
//      PlanValidator / Agent / Permission Gateway.
//   6. No provider credential or provider URL appears in the prompt or in
//      the frontend source that builds it.
//
// This suite never weakens validation: where AIBrain previously rejected
// untrusted output, it must still reject it.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};
globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; } }
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
globalThis.Blob = class { constructor() {} };
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};
// NOTE: `fetch` is deliberately left untouched — the end-to-end section
// below drives the real HttpModelAdapter against the real local gateway.

const { contextBuilder } = await import('../js/ai/contextBuilder.js');
const { AIBrain } = await import('../js/ai/aiBrain.js');
const { ModelAdapter } = await import('../js/ai/modelAdapter.js');
const { planValidator } = await import('../js/ai/planValidator.js');
const { toolDiscovery } = await import('../js/ai/toolDiscovery.js');
const { skillManager } = await import('../js/skillManager.js');
const { permissions } = await import('../js/permissions.js');
const { agent } = await import('../js/agent.js');
const { memory } = await import('../js/memory.js');
const { integrations } = await import('../js/integrations.js');
const { HttpModelAdapter } = await import('../js/ai/httpModelAdapter.js');
const { createGatewayServer } = await import('../server/gateway.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

/**
 * Minimal adapter that records the prompt it receives and replies with a
 * canned model payload, mirroring HttpModelAdapter's result shape for a
 * structured response format ({ text, structured }).
 */
class RecordingAdapter extends ModelAdapter {
    constructor(reply) {
        super();
        this._reply = reply;
        this.lastPrompt = null;
        this.lastOptions = null;
        this.calls = 0;
    }

    async generate(prompt, options = {}) {
        this.calls++;
        this.lastPrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
        this.lastOptions = { ...options };

        const text = typeof this._reply === 'function'
            ? this._reply(this.lastPrompt, options)
            : this._reply;

        let structured = null;
        try {
            structured = JSON.parse(text);
        } catch (e) {
            structured = null;
        }
        return { text, structured };
    }
}

// ==================================================================
// 1) The generated prompt contains the explicit output contract
// ==================================================================
console.log('1) Prompt contains the explicit, machine-readable response contract');
const informationalContext = contextBuilder.buildContext({ request: 'What is the capital of India?' });
const prompt = contextBuilder.formatForPrompt(informationalContext);
{
    check('prompt carries a dedicated output-contract section',
        /Required JSON Output Contract/i.test(prompt));
    check('prompt demands exactly one JSON object',
        /Return ONLY one JSON object/i.test(prompt));
    check('prompt documents the direct response shape',
        prompt.includes('{"response": "your natural-language answer"}'));
    check('prompt documents the structured action plan shape',
        prompt.includes('"goal"') && prompt.includes('"steps"') &&
        prompt.includes('"id"') && prompt.includes('"skill"') && prompt.includes('"input"'));
    check('prompt requires at least one step when a plan is returned',
        /"steps" must contain at least one step/i.test(prompt));
    check('prompt instructs the model to prefer the direct response form',
        /Choose the direct \{"response": "\.\.\."\} form whenever no registered tool/i.test(prompt));
    check('prompt forbids returning both forms at once',
        /Never return "response" and "steps"/i.test(prompt));
    check('prompt restricts the model to the listed tools',
        /Use ONLY the skill names listed under "Available Tools"/i.test(prompt));
    check('prompt forbids inventing skills', /Never invent a skill/i.test(prompt));
    check('prompt forbids executable output',
        /Never generate JavaScript, shell commands, executable code/i.test(prompt));
    check('prompt states model output stays untrusted',
        /untrusted data/i.test(prompt));
    check('prompt still lists the available tools section',
        /Available Tools:/.test(prompt));
    check('prompt ends with the user request (existing contract preserved)',
        prompt.trimEnd().endsWith('User Request: "What is the capital of India?"'));
    check('the informational example is present verbatim in the contract',
        prompt.includes('Reply: {"response": "The capital of India is New Delhi."}'));
    check('the explanation example is present verbatim in the contract',
        prompt.includes('Quantum computing is a type of computing that uses quantum-mechanical effects'));
}

// ==================================================================
// 2) Markdown / code-fence prohibition
// ==================================================================
console.log('2) Prompt explicitly prohibits Markdown and code fences');
{
    check('prompt forbids Markdown', /Never return Markdown/i.test(prompt));
    check('prompt forbids code fences by name', /never wrap the JSON in code fences/i.test(prompt));
    check('prompt shows the concrete fence tokens it forbids', prompt.includes('```'));
}

// ==================================================================
// 3) The example skill is a genuinely registered skill
// ==================================================================
console.log('3) Actionable example uses a registered skill name');
{
    // ------------------------------------------------------------------
    // (a) REGISTRATION CLAIMS — asserted against real repository data
    //     (toolDiscovery / skillManager), never against a hand-made object.
    // ------------------------------------------------------------------
    const registeredNames = toolDiscovery.getToolDefinitions().map(t => t.name);

    check('calculator is genuinely registered (skillManager)',
        skillManager.hasSkill('calculator') && skillManager.getSkill('calculator').name === 'calculator');
    check('calculator is exposed by real tool discovery',
        registeredNames.includes('calculator') && toolDiscovery.hasTool('calculator'));

    const exampleLine = prompt.split('\n').find(l => l.startsWith('Reply: {"goal": "Calculate 25 percent of 800"'));
    check('actionable example is present', typeof exampleLine === 'string');

    // The skill name is read OUT of the generated contract and then verified
    // against real registration data — the literal 'calculator' is not assumed.
    let exampleSkill = null;
    try {
        exampleSkill = JSON.parse(exampleLine.replace(/^Reply:\s*/, '')).steps[0].skill;
    } catch (e) {
        exampleSkill = null;
    }
    check('the example names a genuinely registered, discoverable skill',
        typeof exampleSkill === 'string' &&
        skillManager.hasSkill(exampleSkill) &&
        toolDiscovery.hasTool(exampleSkill) &&
        registeredNames.includes(exampleSkill));
    check('the example skill is the repository\'s calculator skill', exampleSkill === 'calculator');
    check('the example step uses the documented "id"/"skill"/"input" keys',
        /^Reply: \{"goal": "Calculate 25 percent of 800", "steps": \[\{"id": "step1", "skill": "[a-z0-9_-]+", "input": "25 percent of 800"\}\]\}$/.test(exampleLine || ''));

    // The example itself must be a plan the validator accepts — which is only
    // possible because the named skill really is registered.
    const exampleValidation = planValidator.validate(JSON.parse(exampleLine.replace(/^Reply:\s*/, '')));
    check('the contract example passes PlanValidator as a real plan', exampleValidation.valid === true);

    // ------------------------------------------------------------------
    // (b) FORMATTING-ONLY FIXTURES — a synthetic descriptor used purely to
    //     exercise prompt FORMATTING (which name the example picks when
    //     'calculator' is not among the offered tools). These fixtures are
    //     NOT evidence that any skill is registered: the name is taken from
    //     real discovery data above, and the registration claims are the
    //     checks in (a).
    // ------------------------------------------------------------------
    const fixtureSkillName = registeredNames.find(n => n !== 'calculator' && n !== 'core');
    check('FORMATTING fixture reuses a real registered skill name',
        typeof fixtureSkillName === 'string' && skillManager.hasSkill(fixtureSkillName));

    const fixtureContext = contextBuilder.buildContext({
        request: 'a request that needs one registered tool',
        includeMemory: false,
        includeHistory: false,
        includeTaskState: false
    });

    // Synthetic descriptor, real skill name: this only tests formatting.
    const syntheticTools = [{
        name: fixtureSkillName,
        description: 'synthetic fixture descriptor (formatting test only)',
        inputs: [{ name: 'input', description: 'synthetic fixture input' }],
        risk: 'safe'
    }];
    const fixturePrompt = contextBuilder.formatForPrompt({ ...fixtureContext, tools: syntheticTools });
    check('FORMATTING: the example reuses an offered tool name when calculator is absent',
        fixturePrompt.includes(`"skill": "${fixtureSkillName}"`));

    const noToolsPrompt = contextBuilder.formatForPrompt({ ...fixtureContext, tools: [] });
    check('FORMATTING: with no offered tools the example falls back to the built-in "core" tool',
        noToolsPrompt.includes('"skill": "core"'));
    check('the built-in "core" tool is a real tool exposed by discovery',
        toolDiscovery.hasTool('core') && registeredNames.includes('core'));
}

// ==================================================================
// 4) Informational requests: {response} is accepted (no fallback)
// ==================================================================
console.log('4) Direct informational requests are accepted, not sent to fallback');
{
    const adapter = new RecordingAdapter('{"response": "The capital of India is New Delhi."}');
    const brain = new AIBrain({ adapter });

    const result = await brain.processRequest('What is the capital of India?');

    check('informational request succeeds', result.success === true);
    check('informational request is not a fallback', result.fallback !== true);
    check('informational request is not treated as a multi-step plan', result.isMultiStep === false);
    check('model natural-language answer is returned verbatim',
        result.response === 'The capital of India is New Delhi.');
    check('the contract was in the prompt the adapter received',
        /Required JSON Output Contract/i.test(adapter.lastPrompt));
    check('the user request reached the model',
        adapter.lastPrompt.includes('What is the capital of India?'));
    check('the structured response format was still requested',
        adapter.lastOptions?.responseFormat === 'plan');
}

// ==================================================================
// 5) Explanatory requests: {response} is accepted (no fallback)
// ==================================================================
console.log('5) Explanatory requests are accepted, not sent to fallback');
{
    const adapter = new RecordingAdapter(JSON.stringify({
        response: 'Quantum computing is a type of computing that uses quantum-mechanical effects to process information.'
    }));
    const brain = new AIBrain({ adapter });

    const result = await brain.processRequest('Explain quantum computing in simple words.');

    check('explanatory request succeeds', result.success === true);
    check('explanatory request is not a fallback', result.fallback !== true);
    check('explanatory answer is returned', /quantum/i.test(result.response || ''));
    check('prompt contained the output contract', /Required JSON Output Contract/i.test(adapter.lastPrompt));
}

// ==================================================================
// 6) Actionable requests: {goal, steps} is validated, then executed
// ==================================================================
console.log('6) Actionable requests are accepted as a validated plan');
{
    const planJson = JSON.stringify({
        goal: 'Calculate 25 percent of 800',
        steps: [{ id: 'step1', skill: 'calculator', input: '25 percent of 800' }]
    });
    const adapter = new RecordingAdapter(planJson);
    const brain = new AIBrain({ adapter });

    const result = await brain.processRequest('Calculate 25 percent of 800.');

    check('actionable request succeeds', result.success === true);
    check('actionable request is detected as multi-step', result.isMultiStep === true);
    check('plan step binds the registered calculator skill', result.plan?.[0]?.skill === 'calculator');
    check('plan was normalized by the PlanValidator', result.plan?.every(s => typeof s.skill === 'string') === true);

    const validation = planValidator.validate(JSON.parse(planJson));
    check('the same shape passes PlanValidator directly', validation.valid === true);

    // End-to-end: validated model plan -> Agent -> Permission Gateway -> skill.
    let promptFired = false;
    permissions.onPrompt(() => { promptFired = true; });
    const execution = await agent.executePlan(
        { isMultiStep: true, goal: 'Calculate 25 percent of 800', plan: result.plan },
        () => {}
    );
    permissions.onPrompt(null);
    check('safe planned action needs no confirmation prompt', promptFired === false);
    check('agent executed the validated plan', execution?.success === true);
    check('calculator produced the expected result',
        execution?.context?.step1?.value === 200 ||
        /25% of 800 = 200/.test(String(execution?.context?.step1?.result || '')));
}

// ==================================================================
// 7) Security boundary unchanged — unusable or hostile output still fails
// ==================================================================
console.log('7) Security boundary unchanged: unusable or hostile output is still rejected');
{
    // 7a. A JSON object that is neither of the two contract shapes.
    const offContract = new RecordingAdapter('{"answer": "New Delhi"}');
    const offContractBrain = new AIBrain({ adapter: offContract });
    let offContractResult = null;
    try {
        offContractResult = await offContractBrain.processRequest('What is the capital of India?');
    } catch (e) {
        offContractResult = { success: false, fallback: true, error: e.message };
    }
    check('off-contract JSON does not become a response', offContractResult.success === false);
    check('off-contract JSON is flagged as fallback', offContractResult.fallback === true);

    // 7b. A plan naming an unregistered skill.
    const unknownSkill = new RecordingAdapter(JSON.stringify({
        goal: 'do something unknown',
        steps: [{ id: 'step1', skill: 'totallyUnknownSkill', input: 'x' }]
    }));
    const unknownResult = await new AIBrain({ adapter: unknownSkill }).processRequest('do something unknown');
    check('unregistered skill is rejected', unknownResult.success === false);
    check('unregistered skill raises the fallback flag', unknownResult.fallback === true);
    check('validation errors are reported',
        Array.isArray(unknownResult.validationErrors) && unknownResult.validationErrors.length > 0);

    // 7c. Executable code smuggled into a step input.
    const injected = new RecordingAdapter(JSON.stringify({
        goal: 'inject',
        steps: [{ id: 'step1', skill: 'notes', input: 'eval("window.localStorage.clear()")' }]
    }));
    const injectedResult = await new AIBrain({ adapter: injected }).processRequest('inject code');
    check('executable code in a plan is rejected', injectedResult.success === false);

    // ------------------------------------------------------------------
    // 7d. BOTH forms in one object: PROMPT CONTRACT vs RUNTIME BEHAVIOUR.
    //
    //     These are two different claims and must not be conflated:
    //
    //     * PROMPT CONTRACT (asserted in section 1) — the prompt instructs
    //       the model never to emit both forms.
    //     * RUNTIME BEHAVIOUR — AIBrain is NOT a structural exclusivity
    //       enforcer: generatePlan() checks `steps` first, so an object
    //       that also carries a `response` field is handled as a plan
    //       whenever that plan passes PlanValidator. The extra `response`
    //       field is never used as the answer.
    //
    //     Enforcing exclusivity inside AIBrain would be a production
    //     behaviour change and is explicitly out of scope here. What IS
    //     tested is that the ambiguous shape grants no security bypass.
    //     The skill below is genuinely registered (calculator, resolved
    //     through real discovery), so no unrelated failure can explain
    //     the outcome.
    // ------------------------------------------------------------------
    check('PROMPT CONTRACT: the model is instructed never to emit both forms',
        /Never return "response" and "steps"/i.test(prompt));

    const ambiguousSkill = toolDiscovery.getToolDefinitions()
        .map(t => t.name)
        .find(n => n === 'calculator') || null;
    check('ambiguous-shape tests use a genuinely registered skill', ambiguousSkill === 'calculator');

    const ambiguousPayload = {
        response: 'some answer',
        goal: 'some goal',
        steps: [{ id: 'step1', skill: ambiguousSkill, input: '25 percent of 800' }]
    };
    const ambiguous = new RecordingAdapter(JSON.stringify(ambiguousPayload));
    let ambiguousResult = null;
    try {
        ambiguousResult = await new AIBrain({ adapter: ambiguous }).processRequest('Calculate 25 percent of 800.');
    } catch (e) {
        ambiguousResult = { success: false, fallback: true, error: e.message };
    }

    // Documented current behaviour — NOT a mutual-exclusivity guarantee.
    check('RUNTIME BEHAVIOUR: AIBrain does not reject a structurally valid plan merely for an extra "response" field',
        ambiguousResult.success === true && ambiguousResult.isMultiStep === true);
    check('the extra "response" field is never used as the answer',
        ambiguousResult.response !== 'some answer' && ambiguousResult.response === undefined);
    check('the ambiguous shape gets no validation shortcut: the plan half is normalized as usual',
        ambiguousResult.plan?.[0]?.skill === ambiguousSkill &&
        ambiguousResult.plan?.every(s => typeof s.skill === 'string') === true);

    // ---- Security bypass attempts through the ambiguous shape ----------
    // None of the following may be relaxed by the presence of an extra
    // "response" field.

    // (i) A plan half naming an unregistered skill is still rejected.
    const ambiguousUnknown = new RecordingAdapter(JSON.stringify({
        response: 'some answer',
        goal: 'some goal',
        steps: [{ id: 'step1', skill: 'totallyUnknownSkill', input: 'x' }]
    }));
    const ambiguousUnknownResult = await new AIBrain({ adapter: ambiguousUnknown }).processRequest('do it');
    check('ambiguous + unregistered skill is rejected by PlanValidator', ambiguousUnknownResult.success === false);
    check('ambiguous + unregistered skill is flagged as fallback', ambiguousUnknownResult.fallback === true);

    // (ii) Executable code in the plan half is still rejected.
    const ambiguousInjected = new RecordingAdapter(JSON.stringify({
        response: 'some answer',
        goal: 'some goal',
        steps: [{ id: 'step1', skill: 'notes', input: 'eval("window.localStorage.clear()")' }]
    }));
    const ambiguousInjectedResult = await new AIBrain({ adapter: ambiguousInjected }).processRequest('do it');
    check('ambiguous + executable code is rejected by PlanValidator', ambiguousInjectedResult.success === false);

    // (iii) An invalid plan half cannot be rescued by the "response" half.
    const ambiguousInvalidPlan = new RecordingAdapter(JSON.stringify({
        response: 'some answer',
        goal: 'some goal',
        steps: []
    }));
    const ambiguousInvalidResult = await new AIBrain({ adapter: ambiguousInvalidPlan })
        .processRequest('Calculate 25 percent of 800.');
    check('an ambiguous object with an invalid plan half is rejected outright',
        ambiguousInvalidResult.success === false);
    check('rejected ambiguous output raises the fallback flag', ambiguousInvalidResult.fallback === true);
    check('the "response" half never rescues an invalid plan',
        ambiguousInvalidResult.response !== 'some answer');

    // (iv) The Agent / Permission Gateway boundary still applies.
    //      A confirmation-gated action is proposed through the ambiguous
    //      shape, with the model claiming risk "safe" and supplying a
    //      "response". Denying the prompt must leave state untouched.
    const sentinelTitle = 'Contract sentinel note';
    memory.addNote(sentinelTitle, 'must survive an unapproved ambiguous plan');
    const notesBeforeDenial = JSON.stringify(memory.getNotes().map(n => n.title));

    const gatedPayload = {
        response: 'Deleted it for you.',
        goal: 'delete note 1',
        steps: [{ id: 'step1', skill: 'notes', input: 'delete note 1', risk: 'safe' }]
    };
    const gated = new RecordingAdapter(JSON.stringify(gatedPayload));
    const gatedResult = await new AIBrain({ adapter: gated }).processRequest('delete note 1');
    check('ambiguous + gated action is accepted as a plan (documented runtime behaviour)',
        gatedResult.success === true && gatedResult.isMultiStep === true);
    check('the "response" half cannot pre-empt execution (it is never the reply)',
        gatedResult.response === undefined);

    let gatedPromptFired = false;
    permissions.onPrompt(() => {
        gatedPromptFired = true;
        setTimeout(() => permissions.answer(false), 0);   // user DENIES
    });
    const gatedExecution = await agent.executePlan(
        { isMultiStep: true, goal: 'delete note 1', plan: gatedResult.plan },
        () => {}
    );
    permissions.onPrompt(null);

    check('Permission Gateway still prompts for the gated action proposed via the ambiguous shape',
        gatedPromptFired === true);
    check('denied ambiguous plan reports cancellation',
        gatedExecution?.success === false && /cancel|not approved|nothing was changed/i.test(gatedExecution?.response || ''));
    check('denied ambiguous plan changed no state (sentinel note survives)',
        JSON.stringify(memory.getNotes().map(n => n.title)) === notesBeforeDenial &&
        memory.getNotes().some(n => n.title === sentinelTitle));

    // Control: the very same plan, approved, really does act — so the denial
    // above is what protected the state, not an inert skill.
    memory.addNote('Second sentinel note', 'approved-path control');
    let approvedControlRan = false;
    permissions.onPrompt(() => {
        approvedControlRan = true;
        setTimeout(() => permissions.answer(true), 0);    // user APPROVES
    });
    const approvedExecution = await agent.executePlan(
        { isMultiStep: true, goal: 'delete note 2', plan: gatedResult.plan },
        () => {}
    );
    permissions.onPrompt(null);
    check('CONTROL: the same gated plan, approved, executes (the denial was meaningful)',
        approvedControlRan === true && approvedExecution?.success === true &&
        !memory.getNotes().some(n => n.title === 'Second sentinel note'));

    // (v) A sensitive skill keeps its manifest classification: the model's
    //     own risk claim and the extra "response" field buy nothing. The
    //     permission gateway classifies from the skill manifest, so the
    //     confirmation prompt fires regardless of what the model declared.
    const sensitiveTool = toolDiscovery.getToolDefinitions().find(t => t.name === 'iot');
    check('iot is a genuinely registered sensitive skill',
        !!sensitiveTool && sensitiveTool.risk === 'sensitive' && skillManager.hasSkill('iot'));

    const sensitivePayload = {
        response: 'Turning it on.',
        goal: 'turn on the light',
        steps: [{ id: 'step1', skill: 'iot', input: 'turn on the light', risk: 'safe' }]
    };
    const sensitive = new RecordingAdapter(JSON.stringify(sensitivePayload));
    const sensitiveResult = await new AIBrain({ adapter: sensitive }).processRequest('turn on the light');
    check('ambiguous + sensitive skill is accepted as a plan (documented runtime behaviour)',
        sensitiveResult.success === true && sensitiveResult.plan?.[0]?.skill === 'iot');

    // Device state is the observable side effect here (the integrations layer
    // is a local simulated device registry, so a network counter would be
    // vacuous). Start from a known state: the Desk Lamp is explicitly off.
    const deskLamp = integrations.listDevices().find(d => d.type === 'light');
    await integrations.invoke(deskLamp.id, 'off');
    check('device-state fixture starts from a known OFF state',
        integrations.getDevice(deskLamp.id)?.state?.on === false);

    let sensitivePromptFired = false;
    permissions.onPrompt(() => {
        sensitivePromptFired = true;
        setTimeout(() => permissions.answer(false), 0);   // user DENIES
    });
    const sensitiveExecution = await agent.executePlan(
        { isMultiStep: true, goal: 'turn on the light', plan: sensitiveResult.plan },
        () => {}
    );
    permissions.onPrompt(null);

    check('model-claimed risk "safe" on a sensitive skill does not suppress the confirmation prompt',
        sensitivePromptFired === true);
    check('denied sensitive action is not executed (device state unchanged)',
        sensitiveExecution?.success === false &&
        integrations.getDevice(deskLamp.id)?.state?.on === false);

    // Control: the same plan, approved, really does act on the device.
    let sensitiveApprovedRan = false;
    permissions.onPrompt(() => {
        sensitiveApprovedRan = true;
        setTimeout(() => permissions.answer(true), 0);    // user APPROVES
    });
    const sensitiveApproved = await agent.executePlan(
        { isMultiStep: true, goal: 'turn on the light again', plan: sensitiveResult.plan },
        () => {}
    );
    permissions.onPrompt(null);
    check('CONTROL: the same sensitive plan, approved, does act on the device',
        sensitiveApprovedRan === true && sensitiveApproved?.success === true &&
        integrations.getDevice(deskLamp.id)?.state?.on === true);

    // 7e. PARSER TOLERANCE (pre-existing behaviour, deliberately NOT changed).
    //     The prompt now PROHIBITS code fences, but ModelAdapter's existing
    //     tolerant parser still extracts fenced JSON. This is documented as
    //     tolerance — it is not a rejection, and no validation is skipped:
    //     the extracted object still goes through the normal path.
    const fenced = new RecordingAdapter('```json\n{"response": "Fenced answers are still parsed."}\n```');
    const fencedResult = await new AIBrain({ adapter: fenced }).processRequest('say something');
    check('PARSER TOLERANCE: fenced JSON is still parsed by the unchanged parser (tolerated, NOT rejected)',
        fencedResult.success === true && fencedResult.response === 'Fenced answers are still parsed.');

    // Fence tolerance must not become a plan bypass: a fenced PLAN is still
    // validated exactly like an unfenced one.
    const fencedUnknownPlan = new RecordingAdapter(
        '```json\n' + JSON.stringify({
            goal: 'fenced unknown skill',
            steps: [{ id: 'step1', skill: 'totallyUnknownSkill', input: 'x' }]
        }) + '\n```'
    );
    const fencedUnknownResult = await new AIBrain({ adapter: fencedUnknownPlan }).processRequest('do it');
    check('a fenced plan naming an unregistered skill is still rejected', fencedUnknownResult.success === false);

    // 7f. The enforcement instance is unchanged.
    check('AIBrain still uses the singleton PlanValidator',
        new AIBrain({ adapter: offContract }).getValidator() === planValidator);
}

// ==================================================================
// 8) No provider credentials or provider URLs introduced
// ==================================================================
console.log('8) No provider credentials or provider URLs in frontend code');
{
    const FORBIDDEN = [
        'api.groq.com',
        'api.openai.com',
        'openrouter.ai',
        'generativelanguage.googleapis.com',
        'GROQ_API_KEY',
        'OPENAI_API_KEY',
        'OPENROUTER_API_KEY'
    ];

    const source = readFileSync(join(ROOT, 'js/ai/contextBuilder.js'), 'utf8');
    const hits = FORBIDDEN.filter(needle => source.includes(needle) || prompt.includes(needle));
    check('no provider hostname or provider API key name in the builder or its prompt',
        hits.length === 0);

    check('the prompt contains no absolute URL',
        !/https?:\/\//i.test(prompt));
    check('the prompt contains no executable transport instruction',
        !/\b(fetch|XMLHttpRequest)\s*\(/i.test(prompt));
}

// ==================================================================
// 9) End-to-end: AIBrain → HttpModelAdapter → local gateway → provider
// ==================================================================
// The full chain is exercised with a local, deterministic upstream that
// behaves like a contract-compliant model. No real provider, credential or
// external network is involved.
console.log('9) End-to-end contract through the local gateway (mock upstream provider)');

/** Deterministic local upstream, OpenAI-compatible. */
async function startMockUpstream(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try { body = JSON.parse(raw); } catch (e) { body = null; }
            requests.push({ body, raw });
            handler(res, body);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise(resolve => server.close(resolve))
    };
}

function respondOpenAI(res, text) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: 'mock-upstream',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
    }));
}

/** A model that OBEYS the injected contract (informational vs actionable). */
function contractCompliantModel(body) {
    const prompt = body?.messages?.[0]?.content || '';
    const userRequest = (prompt.match(/User Request:\s*"([^"]+)"/i) || [])[1] || '';

    if (/capital of India/i.test(userRequest)) {
        return JSON.stringify({ response: 'The capital of India is New Delhi.' });
    }
    if (/percent of/i.test(userRequest)) {
        return JSON.stringify({
            goal: userRequest,
            steps: [{ id: 'step1', skill: 'calculator', input: userRequest }]
        });
    }
    return JSON.stringify({ response: `No contract-shaped answer for: ${userRequest}` });
}

// A deliberately fake key: gateway-side configuration only, never frontend.
const FAKE_SERVER_KEY = 'sk-test-contract-only-not-a-real-credential';

const upstream = await startMockUpstream((res, body) => respondOpenAI(res, contractCompliantModel(body)));
const gateway = createGatewayServer({
    port: 0,
    provider: 'groq',
    groqApiKey: FAKE_SERVER_KEY,
    providerEndpoints: { groq: `${upstream.url}/v1/chat/completions` },
    rateLimitPerMinute: 100000
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const gatewayPort = gateway.address().port;

const httpAdapter = new HttpModelAdapter({
    gatewayUrl: `http://127.0.0.1:${gatewayPort}/api/ai/generate`,
    timeout: 5000
});
const endToEndBrain = new AIBrain({ adapter: httpAdapter });

const infoResult = await endToEndBrain.processRequest('What is the capital of India?');
const actionableResult = await endToEndBrain.processRequest('Calculate 25 percent of 800.');

const providerPrompts = upstream.requests.map(r => r.body?.messages?.[0]?.content || '');
check('two provider calls were made (one per request)', upstream.requests.length === 2);
check('every provider prompt carries the output contract',
    providerPrompts.length === 2 && providerPrompts.every(p => /Required JSON Output Contract/i.test(p)));
check('the gateway still requests JSON mode from the provider',
    upstream.requests.every(r => r.body?.response_format?.type === 'json_object'));

check('informational request returns the provider answer (no fallback)',
    infoResult.success === true && infoResult.isMultiStep === false &&
    infoResult.response === 'The capital of India is New Delhi.');
check('informational request was not sent to the fallback path', infoResult.fallback !== true);

check('actionable request returns a validated multi-step plan',
    actionableResult.success === true && actionableResult.isMultiStep === true);
check('end-to-end plan binds the registered calculator skill',
    actionableResult.plan?.[0]?.skill === 'calculator');

await new Promise(resolve => gateway.close(resolve));
await upstream.close();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
