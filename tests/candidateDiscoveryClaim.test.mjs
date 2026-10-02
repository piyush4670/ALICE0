// Focused Part 10.2 test suite: Candidate Discovery vs Claim Permission
// Validates architectural separation between candidate discovery and
// deterministic execution authorization in SkillManager and TaskPlanner.

// --- Browser globals (minimal mocks, matching existing test suites) ----------
globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; } },
    open() {}, SpeechRecognition: undefined, webkitSpeechRecognition: undefined,
    AudioContext: undefined, webkitAudioContext: undefined
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: undefined, permissions: undefined }, configurable: true
});
function genericElement() {
    return {
        style: {}, textContent: '', innerText: '', value: '', innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        appendChild() {}, removeChild() {}, remove() {},
        setAttribute() {}, focus() {}, click() {}, getContext() { return null; }
    };
}
globalThis.document = {
    createElement: () => genericElement(),
    body: { appendChild() {}, removeChild() {}, innerText: 'candidate discovery test' },
    title: 'Candidate Discovery Test',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};

const { skillManager, SkillManager } = await import('../js/skillManager.js');
const { taskPlanner } = await import('../js/taskPlanner.js');
const { agent } = await import('../js/agent.js');
const { planValidator } = await import('../js/ai/planValidator.js');
const { state } = await import('../js/state.js');
const { memory } = await import('../js/memory.js');
const { permissions } = await import('../js/permissions.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

// ============================================================================
console.log('A) Strong candidate — discovery vs claim authorization');
{
    const candCalc = skillManager.findBestCandidate('2 + 2');
    check('candidate is discovered for "2 + 2"',
        candCalc.candidate && candCalc.candidate.name === 'calculator' &&
        candCalc.candidateName === 'calculator');
    check('discovery specifies pattern evidence and specificity',
        candCalc.matchType === 'pattern' && candCalc.matchedBy === 'pattern' &&
        candCalc.specificity >= 1 && candCalc.score === 1.0);
    check('discovery confidence is strong',
        candCalc.confidence === 'strong' && candCalc.decision === 'strong');
    check('candidate discovery does NOT authorize claim (claimed/routed are false, skill is null)',
        candCalc.claimed === false && candCalc.routed === false && candCalc.skill === null);
    check('canClaimCandidate authorizes strong unambiguous candidate',
        skillManager.canClaimCandidate(candCalc) === true);

    const claimCalc = skillManager.matchSkill('2 + 2');
    check('matchSkill claims strong candidate and binds skill',
        claimCalc.claimed === true && claimCalc.routed === true &&
        claimCalc.skill && claimCalc.skill.name === 'calculator' &&
        claimCalc.decision === 'strong');
    check('matchSkill includes candidate-discovery metadata on strong match',
        claimCalc.candidate && claimCalc.candidate.name === 'calculator' &&
        claimCalc.candidateName === 'calculator' &&
        claimCalc.confidence === 'strong' && claimCalc.matchType === 'pattern');

    const candBrowser = skillManager.findBestCandidate('open the website example.com');
    check('browser candidate is discovered without claiming',
        candBrowser.candidate && candBrowser.candidate.name === 'browser' &&
        candBrowser.confidence === 'strong' && candBrowser.claimed === false && candBrowser.skill === null);
    const claimBrowser = skillManager.matchSkill('open the website example.com');
    check('browser claim succeeds via matchSkill',
        claimBrowser.claimed === true && claimBrowser.skill && claimBrowser.skill.name === 'browser');

    const candTime = skillManager.findBestCandidate('what time is it');
    check('datetime candidate is discovered without claiming',
        candTime.candidate && candTime.candidate.name === 'datetime' &&
        candTime.confidence === 'strong' && candTime.claimed === false && candTime.skill === null);
    const claimTime = skillManager.matchSkill('what time is it');
    check('datetime claim succeeds via matchSkill',
        claimTime.claimed === true && claimTime.skill && claimTime.skill.name === 'datetime');

    const internalCand = skillManager._findBestCandidate('2 + 2');
    check('_findBestCandidate agrees with public findBestCandidate',
        internalCand.candidateName === candCalc.candidateName &&
        internalCand.confidence === candCalc.confidence &&
        internalCand.claimed === false && internalCand.skill === null);
}

// ============================================================================
console.log('\nB) Weak candidate — discovery vs claim decline');
{
    const candWeak = skillManager.findBestCandidate('add two numbers');
    check('candidate is discovered for weak input ("add two numbers")',
        candWeak.candidate && candWeak.candidate.name === 'calculator' &&
        candWeak.candidateName === 'calculator');
    check('weak evidence is identified as keyword tier',
        candWeak.matchType === 'keyword' && candWeak.score >= 0.3 && candWeak.specificity === 0);
    check('confidence is classified as weak',
        candWeak.confidence === 'weak' && candWeak.decision === 'weak');
    check('discovery does not grant claim for weak candidate',
        candWeak.claimed === false && candWeak.routed === false && candWeak.skill === null);
    check('canClaimCandidate declines weak candidate',
        skillManager.canClaimCandidate(candWeak) === false);

    const claimWeak = skillManager.matchSkill('add two numbers');
    check('matchSkill declines claim for weak candidate (skill is null, claimed is false)',
        claimWeak.claimed === false && claimWeak.routed === false &&
        claimWeak.skill === null && claimWeak.decision === 'weak');
    check('matchSkill still exposes discovered weak candidate in metadata',
        claimWeak.candidate && claimWeak.candidate.name === 'calculator' &&
        claimWeak.candidateName === 'calculator' &&
        claimWeak.confidence === 'weak' && claimWeak.matchType === 'keyword');

    const historyBefore = skillManager.getHistory().length;
    const processResult = await skillManager.process('add two numbers');
    check('process() declines weak request with no silent skill execution',
        processResult.success === false && /not sure how to help/i.test(processResult.error));
    check('no skill execution history was recorded for weak candidate',
        skillManager.getHistory().length === historyBefore);

    const candWeather = skillManager.findBestCandidate('the weather seems nice today');
    const claimWeather = skillManager.matchSkill('the weather seems nice today');
    check('weak datetime candidate is discovered but not claimed',
        candWeather.candidate && candWeather.candidate.name === 'datetime' &&
        candWeather.confidence === 'weak' &&
        claimWeather.skill === null && claimWeather.claimed === false &&
        claimWeather.candidateName === 'datetime');

    const candDev = skillManager.findBestCandidate('write a javascript function');
    const claimDev = skillManager.matchSkill('write a javascript function');
    check('weak dev candidate is discovered but not claimed',
        candDev.candidate && candDev.candidate.name === 'dev' &&
        candDev.confidence === 'weak' &&
        claimDev.skill === null && claimDev.claimed === false &&
        claimDev.candidateName === 'dev');
}

// ============================================================================
console.log('\nC) Ambiguous candidates — discoverable, declined, registration-order independent');
{
    const amb = skillManager.findBestCandidate('find the latest error in the code');
    check('candidates are discoverable for ambiguous match',
        amb.candidates && amb.candidates.length === 2);
    check('contenders explicitly list both competing skills in deterministic order',
        JSON.stringify(amb.contenders) === JSON.stringify(['dev', 'websearch']));
    check('confidence is classified as ambiguous',
        amb.confidence === 'ambiguous' && amb.decision === 'ambiguous');
    check('candidate discovery does not pick an arbitrary winner (candidate is null)',
        amb.candidate === null && amb.candidateName === null);
    check('canClaimCandidate declines ambiguous candidate info',
        skillManager.canClaimCandidate(amb) === false);

    const claimAmb = skillManager.matchSkill('find the latest error in the code');
    check('claim is declined for ambiguous match',
        claimAmb.claimed === false && claimAmb.routed === false &&
        claimAmb.skill === null && claimAmb.candidate === null &&
        claimAmb.decision === 'ambiguous');
    check('claim exposes contenders deterministically',
        JSON.stringify(claimAmb.contenders) === JSON.stringify(['dev', 'websearch']));

    // Prove registration-order independence with reversed registration across corpus
    const reordered = new SkillManager();
    const skillsBefore = reordered.getSkills();
    for (const s of skillsBefore) reordered.unregister(s.name);
    for (const s of skillsBefore.slice().reverse()) reordered.register(s);

    const ambReordered = reordered.findBestCandidate('find the latest error in the code');
    check('reverse registration order discovers the exact same contenders',
        JSON.stringify(ambReordered.contenders) === JSON.stringify(['dev', 'websearch']) &&
        ambReordered.confidence === 'ambiguous' && ambReordered.candidate === null);
    check('reverse registration claim remains declined',
        reordered.matchSkill('find the latest error in the code').skill === null &&
        reordered.matchSkill('find the latest error in the code').claimed === false);

    const orderCorpus = [
        '2 + 2',
        'what is 150 plus 75?',
        'read the current page',
        'delete my note about ProcessGuard',
        'add two numbers',
        'find the latest error in the code',
        'the time of my life',
        'hello there friend'
    ];
    const compareDiscovery = orderCorpus.every(text => {
        const a = skillManager.findBestCandidate(text);
        const b = reordered.findBestCandidate(text);
        return a.candidateName === b.candidateName &&
            a.confidence === b.confidence &&
            a.score === b.score &&
            a.specificity === b.specificity &&
            JSON.stringify(a.contenders) === JSON.stringify(b.contenders) &&
            JSON.stringify(a.candidates) === JSON.stringify(b.candidates);
    });
    check('candidate discovery is registration-order independent across all tiers',
        compareDiscovery === true);

    // Pattern-level ambiguity with a twin
    const twin = {
        name: 'route-twin',
        description: 'Test twin for note pattern',
        patterns: [/delete\s+(?:my\s+)?note/i],
        execute: () => ({ success: true, result: 'twin' })
    };
    skillManager.register(twin);

    const candTwin = skillManager.findBestCandidate('delete my note');
    check('pattern-level ambiguous candidates are discoverable without picking a winner',
        candTwin.confidence === 'ambiguous' && candTwin.candidate === null &&
        candTwin.contenders.includes('notes') && candTwin.contenders.includes('route-twin'));
    check('pattern-level ambiguous claim is declined',
        skillManager.matchSkill('delete my note').skill === null &&
        skillManager.matchSkill('delete my note').claimed === false);

    skillManager.unregister('route-twin');
    check('unregistering twin restores unambiguous candidate and strong claim',
        skillManager.findBestCandidate('delete my note').confidence === 'strong' &&
        skillManager.matchSkill('delete my note').claimed === true &&
        skillManager.matchSkill('delete my note').skill.name === 'notes');
}

// ============================================================================
console.log('\nD) TaskPlanner integration — weak/ambiguous visibility, no phantom steps, no automatic execution');
{
    // 1. Weak candidate step is NOT dropped from the multi-step plan
    const planWithWeak = taskPlanner.analyze('calculate 2 + 2 and then add two numbers');
    check('multi-step plan is formed with weak candidate clause',
        planWithWeak.isMultiStep === true && planWithWeak.plan.length === 2);
    check('step 1 has strong claimed skill',
        planWithWeak.plan[0].skill === 'calculator' &&
        planWithWeak.plan[0].candidate === 'calculator' &&
        planWithWeak.plan[0].claimed === true &&
        planWithWeak.plan[0].decision === 'strong');
    check('step 2 preserves weak candidate metadata without execution authorization (skill is null)',
        planWithWeak.plan[1].skill === null &&
        planWithWeak.plan[1].candidate === 'calculator' &&
        planWithWeak.plan[1].claimed === false &&
        planWithWeak.plan[1].decision === 'weak' &&
        planWithWeak.plan[1].confidence === 'weak');

    // 2. Ambiguous candidate step is NOT dropped from the multi-step plan
    const planWithAmb = taskPlanner.analyze('calculate 2 + 2 and then find the latest error in the code');
    check('multi-step plan is formed with ambiguous clause',
        planWithAmb.isMultiStep === true && planWithAmb.plan.length === 2);
    check('ambiguous step preserves contenders and leaves skill and candidate null',
        planWithAmb.plan[1].skill === null &&
        planWithAmb.plan[1].candidate === null &&
        planWithAmb.plan[1].claimed === false &&
        planWithAmb.plan[1].decision === 'ambiguous' &&
        planWithAmb.plan[1].contenders.includes('dev') &&
        planWithAmb.plan[1].contenders.includes('websearch'));

    // 3. Multi-step with only weak candidates retains all steps
    const planAllWeak = taskPlanner.analyze('add two numbers and then write a javascript function');
    check('all-weak multi-step plan retains both steps with skill: null',
        planAllWeak.isMultiStep === true && planAllWeak.plan.length === 2 &&
        planAllWeak.plan[0].candidate === 'calculator' && planAllWeak.plan[0].skill === null &&
        planAllWeak.plan[1].candidate === 'dev' && planAllWeak.plan[1].skill === null);

    // 4. Weak/ambiguous steps are NOT automatically executed by Agent or accepted by PlanValidator
    state.resetTask();
    const historyBeforeWeak = skillManager.getHistory().length;
    const execWeakResult = await agent.process('calculate 2 + 2 and then add two numbers', { speak: () => {} });
    check('agent refuses to execute plan containing unclaimed/weak step',
        execWeakResult === null && state.getTask().status === 'idle');
    check('agent executed zero skills when plan contained a weak step',
        skillManager.getHistory().length === historyBeforeWeak);

    state.resetTask();
    const historyBeforeAmb = skillManager.getHistory().length;
    const execAmbResult = await agent.process('calculate 2 + 2 and then find the latest error in the code', { speak: () => {} });
    check('agent refuses to execute plan containing ambiguous step',
        execAmbResult === null && state.getTask().status === 'idle');
    check('agent executed zero skills when plan contained an ambiguous step',
        skillManager.getHistory().length === historyBeforeAmb);

    const valWeak = planValidator.validate({ goal: planWithWeak.goal, steps: planWithWeak.plan });
    const valAmb = planValidator.validate({ goal: planWithAmb.goal, steps: planWithAmb.plan });
    check('PlanValidator rejects plans with unclaimed weak or ambiguous steps',
        valWeak.valid === false && valAmb.valid === false);

    // 5. Unmatched noise clauses continue to be dropped (no phantom steps)
    const planNoise = taskPlanner.analyze('frobnicate the quux and then what time is it');
    check('unmatched noise clause produces no phantom step (single remaining step rejected)',
        planNoise.isMultiStep === false && planNoise.plan.length === 0);

    const planSubFloor = taskPlanner.analyze('the time of my life and then what time is it');
    check('sub-floor keyword noise clause produces no phantom step',
        planSubFloor.isMultiStep === false && planSubFloor.plan.length === 0);

    const planThreeMixed = taskPlanner.analyze('calculate 2 + 2 and then frobnicate the quux and then what time is it');
    check('noise clause between two strong clauses is dropped without losing valid steps',
        planThreeMixed.isMultiStep === true && planThreeMixed.plan.length === 2 &&
        planThreeMixed.plan[0].skill === 'calculator' &&
        planThreeMixed.plan[1].skill === 'datetime');

    // 6. Strong multi-step plan executes normally
    state.resetTask();
    const strongGoal = 'calculate 2 + 2 and then calculate 3 + 3';
    const planStrong = taskPlanner.analyze(strongGoal);
    check('strong multi-step plan has valid skill strings for all steps',
        planStrong.isMultiStep === true && planStrong.plan.length === 2 &&
        planStrong.plan.every(s => typeof s.skill === 'string' && s.claimed === true));
    const execStrongResult = await agent.process(strongGoal, { speak: () => {} });
    check('strong multi-step plan executes to completion',
        execStrongResult !== null && execStrongResult.success === true &&
        state.getTask().status === 'completed');
    state.resetTask();

    // 7. Determinism: repeated analysis produces identical plan structures
    const p1 = JSON.stringify(taskPlanner.analyze('calculate 2 + 2 and then add two numbers'));
    const p2 = JSON.stringify(taskPlanner.analyze('calculate 2 + 2 and then add two numbers'));
    check('taskPlanner.analyze is strictly deterministic across repeated calls',
        p1 === p2);
}

// ============================================================================
console.log('\nE) Existing strong routing regression tests');
{
    check('calculate 25 * 4 claims calculator',
        skillManager.matchSkill('calculate 25 * 4').skill?.name === 'calculator');
    check('15 percent of 200 claims calculator',
        skillManager.matchSkill('15 percent of 200').skill?.name === 'calculator');
    check('square root of 144 claims calculator',
        skillManager.matchSkill('square root of 144').skill?.name === 'calculator');
    check('delete my note about ProcessGuard claims notes',
        skillManager.matchSkill('delete my note about ProcessGuard').skill?.name === 'notes');
    check('remind me to call Alice claims reminders',
        skillManager.matchSkill('remind me to call Alice').skill?.name === 'reminders');
    check('what time is it claims datetime',
        skillManager.matchSkill('what time is it').skill?.name === 'datetime');
    check('go to example.com claims browser',
        skillManager.matchSkill('go to example.com').skill?.name === 'browser');
    check('What is the capital of India? claims websearch',
        skillManager.matchSkill('What is the capital of India?').skill?.name === 'websearch');
}

// ============================================================================
console.log('\nF) Disabled skill behavior');
{
    check('iot is candidate by default',
        skillManager.findBestCandidate('turn on the light').confidence === 'strong');
    check('iot claims by default',
        skillManager.matchSkill('turn on the light').skill?.name === 'iot');

    skillManager.setEnabled('iot', false);
    const candDisabled = skillManager.findBestCandidate('turn on the light');
    check('disabled skill cannot be discovered as candidate',
        candDisabled.decision === 'none' && candDisabled.candidate === null &&
        !candDisabled.candidates.some(c => c.name === 'iot'));

    const claimDisabled = skillManager.matchSkill('turn on the light');
    check('disabled skill cannot claim',
        claimDisabled.skill === null && claimDisabled.claimed === false &&
        claimDisabled.candidate === null);

    const planDisabled = taskPlanner.analyze('turn on the light and then what time is it');
    check('disabled skill clause is dropped by planner (no phantom step)',
        planDisabled.isMultiStep === false && planDisabled.plan.length === 0);

    skillManager.setEnabled('iot', true);
    check('re-enabling restores candidate discovery and claim',
        skillManager.findBestCandidate('turn on the light').confidence === 'strong' &&
        skillManager.matchSkill('turn on the light').skill?.name === 'iot');
}

// ============================================================================
console.log('\nG) Backward compatibility of matchSkill() & Part 10.3 memory-deletion safeguards');
{
    const match = skillManager.matchSkill('2 + 2');
    check('skill property is present and valid skill object',
        match.skill && typeof match.skill.execute === 'function' && match.skill.name === 'calculator');
    check('score property is 1.0', match.score === 1.0);
    check('decision property is "strong"', match.decision === 'strong');
    check('routed property is true', match.routed === true);
    check('claimed property is true', match.claimed === true);
    check('reason property is string', typeof match.reason === 'string' && match.reason.length > 0);
    check('matchedBy property is "pattern"', match.matchedBy === 'pattern');
    check('specificity property is a number', typeof match.specificity === 'number' && match.specificity >= 1);
    check('candidates property is array of plain-data descriptors',
        Array.isArray(match.candidates) && match.candidates.length >= 1 &&
        !('skill' in match.candidates[0]));
    check('contenders property is array', Array.isArray(match.contenders) && match.contenders.length === 0);

    check('_findSkill agrees with matchSkill().skill for strong route',
        skillManager._findSkill('2 + 2')?.name === 'calculator');
    check('_findSkill agrees with matchSkill().skill for weak route (null)',
        skillManager._findSkill('add two numbers') === null);
    check('_route agrees with matchSkill',
        skillManager._route('2 + 2').skill?.name === 'calculator');

    // Verify Part 10.3 safe memory forgetting & permission gating remain intact
    memory.remember('car color', 'blue');
    memory.remember('car model', 'Model 3');
    permissions.onPrompt(() => setTimeout(() => permissions.answer(true), 0));

    const memMatch = skillManager.matchSkill('forget my car');
    check('memory forget request still claims memory skill',
        memMatch.claimed === true && memMatch.skill?.name === 'memory');

    const ambigForget = await skillManager.process('forget my car');
    check('Part 10.3 safeguard: ambiguous memory forget deletes nothing',
        ambigForget.success === false && /didn't delete anything/i.test(ambigForget.error) &&
        memory.hasMemory('car color') === true && memory.hasMemory('car model') === true);

    const exactForget = await skillManager.process('forget my car color');
    check('Part 10.3 safeguard: exact memory forget succeeds when approved',
        exactForget.success === true &&
        memory.hasMemory('car color') === false && memory.hasMemory('car model') === true);

    memory.forget('car model');
    permissions.onPrompt(null);
}

// ============================================================================
console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
