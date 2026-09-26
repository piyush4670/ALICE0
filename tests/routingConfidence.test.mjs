// Focused Part 10.1 suite: deterministic routing confidence (run with node).
// Not part of the app.
//
// The deterministic router must be able to say "no route":
//
//   * strong, unambiguous pattern matches keep routing
//   * weak keyword-only matches (>= 0.3 by the legacy threshold) never claim
//   * equally-ranked matches are reported as ambiguous and are NOT resolved
//     by registration order
//   * requests with no meaningful evidence are reported as 'none'
//   * disabled skills are excluded from every decision
//   * evaluation is pure, synchronous and repeatable
//
// Decisions are asserted directly (decision / routed / candidates / reason)
// instead of relying on execution side effects. Same plain-node + mocked
// browser-globals style as the other suites in this directory.
// Deterministic: no network, no credentials, no real timers.

// --- Browser globals (minimal mocks, matching the other suites) --------------
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
        style: {}, textContent: '', value: '', innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        appendChild() {}, removeChild() {}, remove() {},
        setAttribute() {}, focus() {}, click() {}, getContext() { return null; }
    };
}
globalThis.document = {
    createElement: () => genericElement(),
    body: { appendChild() {}, removeChild() {}, innerText: 'routing confidence test' },
    title: 'Routing Confidence Test',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};

const { skillManager, SkillManager } = await import('../js/skillManager.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

/** The full routing decision for a piece of text. */
const route = (text) => skillManager.matchSkill(text);
/** The skill name the router claims, or null. */
const routed = (text) => { const d = route(text); return d.skill ? d.skill.name : null; };
/** Plain-data projection, for comparing decisions across managers/runs. */
const project = (d) => JSON.stringify({
    skill: d.skill ? d.skill.name : null,
    score: d.score,
    decision: d.decision,
    routed: d.routed,
    matchedBy: d.matchedBy,
    specificity: d.specificity,
    candidates: d.candidates,
    contenders: d.contenders
});
const candidateNames = (d) => d.candidates.map(c => c.name);
const candidate = (d, name) => d.candidates.find(c => c.name === name);

console.log('1) Strong, unambiguous pattern matches stay routable');
{
    const calc = route('2 + 2');
    check('"2 + 2" is a strong calculator route',
        calc.decision === 'strong' && calc.routed === true &&
        calc.skill && calc.skill.name === 'calculator' &&
        calc.score === 1 && calc.matchedBy === 'pattern');
    check('"calculate 25 * 4" is a strong calculator route', routed('calculate 25 * 4') === 'calculator');
    check('"15 percent of 200" is a strong calculator route', routed('15 percent of 200') === 'calculator');
    check('"square root of 144" is a strong calculator route', routed('square root of 144') === 'calculator');

    // A framing pattern ("what is ") fires for websearch on the same text, but
    // the calculator's match is more specific, so the clash is resolved by
    // specificity — not by registration order.
    const math = route('what is 150 plus 75?');
    check('"what is 150 plus 75?" routes to calculator, not to the framing pattern',
        math.skill && math.skill.name === 'calculator' && math.decision === 'strong');
    check('the losing framing match is still visible in the decision',
        math.candidates.length === 2 &&
        candidate(math, 'calculator').specificity > candidate(math, 'websearch').specificity);

    const browser = route('open the website example.com');
    check('"open the website example.com" is a strong browser route',
        browser.decision === 'strong' && browser.skill && browser.skill.name === 'browser');
    check('"go to example.com" is a strong browser route', routed('go to example.com') === 'browser');
    check('"navigate to the site" is a strong browser route', routed('navigate to the site') === 'browser');

    // reader is registered BEFORE browser and both patterns match
    // "read the current page" — the browser's match is more specific.
    const order = skillManager.getSkills().map(s => s.name);
    check('registration order would favour reader, but specificity favours browser',
        order.indexOf('reader') < order.indexOf('browser') && routed('read the current page') === 'browser');

    // notes is registered BEFORE memory; the notes match is more specific.
    check('"delete my note about ProcessGuard" routes to notes (specificity, not order)',
        routed('delete my note about ProcessGuard') === 'notes' &&
        route('delete my note about ProcessGuard').candidates.length === 2);

    check('pattern-matching behaviour is unchanged for existing triggers',
        routed('turn on the light') === 'iot' &&
        routed('what time is it') === 'datetime' &&
        routed('read the file') === 'files' &&
        routed('summarize this') === 'reader');

    // A single framing-only pattern match is still the skill's declared
    // trigger and therefore still routable.
    const knowledge = route('What is the capital of India?');
    check('a lone framing pattern match still routes (knowledge question)',
        knowledge.decision === 'strong' && knowledge.skill && knowledge.skill.name === 'websearch');

    const exec = await skillManager.process('2 + 2');
    check('strong routes still execute through the permission boundary',
        exec.success === true && exec.value === 4);
}

console.log('\n2) Weak keyword-only matches do not claim the request');
{
    const weak = route('add two numbers');
    check('"add two numbers" is reported as weak, not routed',
        weak.decision === 'weak' && weak.routed === false && weak.skill === null);
    check('weak decision names the keyword evidence',
        weak.matchedBy === 'keyword' && weak.score === 0.4 &&
        candidateNames(weak).includes('calculator'));
    check('legacy scoring would have claimed it (>= 0.3 keyword score)',
        skillManager._calculateMatchScore('add two numbers', skillManager.getSkill('calculator')) >= 0.3);

    const weather = route('the weather seems nice today');
    check('"the weather seems nice today" no longer claims datetime',
        weather.decision === 'weak' && weather.skill === null && weather.score === 0.4);

    const dev = route('write a javascript function');
    check('"write a javascript function" no longer claims dev',
        dev.decision === 'weak' && dev.skill === null && dev.matchedBy === 'keyword');

    check('"find my latest file" is weak, not routed to websearch',
        route('find my latest file').decision === 'weak' && routed('find my latest file') === null);

    const noRoute = await skillManager.process('add two numbers');
    check('process() declines a weak keyword-only request',
        noRoute.success === false && /not sure how to help/i.test(noRoute.error));
    check('the calculator is never asked to parse a weak match',
        !/Could not understand the calculation/i.test(String(noRoute.error)));
}

console.log('\n3) Ambiguous matches are explicit and never silently chosen');
{
    // Two skills with the same keyword score: dev (error, code) and
    // websearch (find, latest). Neither may win by registration order.
    const ambiguous = route('find the latest error in the code');
    check('equal keyword evidence is reported as ambiguous',
        ambiguous.decision === 'ambiguous' && ambiguous.routed === false && ambiguous.skill === null);
    check('ambiguous decision exposes both contenders deterministically',
        JSON.stringify(ambiguous.contenders) === JSON.stringify(['dev', 'websearch']) &&
        ambiguous.candidates.length === 2);

    // Pattern-level ambiguity: an equally specific trigger from another skill
    // blocks the claim instead of letting registration order decide.
    const twin = {
        name: 'route-twin',
        description: 'Test-only twin trigger for routing confidence',
        patterns: [/delete\s+(?:my\s+)?note/i],
        execute: () => ({ success: true, result: 'twin' })
    };
    check('test twin registers', skillManager.register(twin) === true);
    const tied = route('delete my note');
    check('equally specific pattern matches are ambiguous, not routed',
        tied.decision === 'ambiguous' && tied.routed === false && tied.skill === null);
    check('contenders list both equally specific skills in a stable order',
        JSON.stringify(tied.contenders) === JSON.stringify(['notes', 'route-twin']));
    const topTied = tied.candidates.filter(c => c.tier === 'pattern' && c.specificity === 2);
    check('both equally specific pattern candidates are visible',
        topTied.length === 2 &&
        topTied.every(c => ['notes', 'route-twin'].includes(c.name)));
    check('a less specific pattern match cannot win the tie either',
        candidate(tied, 'memory') && candidate(tied, 'memory').specificity === 1 && tied.skill === null);
    skillManager.unregister('route-twin');
    const restored = route('delete my note');
    check('removing the twin restores the strong route',
        restored.decision === 'strong' && restored.skill && restored.skill.name === 'notes' &&
        restored.contenders.length === 0);
    check('the twin is gone from the registry', !skillManager.hasSkill('route-twin'));
}

console.log('\n4) Requests with no meaningful match');
{
    const nothing = route('hello there friend');
    check('"hello there friend" has no evidence at all',
        nothing.decision === 'none' && nothing.routed === false &&
        nothing.skill === null && nothing.score === 0 && nothing.candidates.length === 0);
    check('"frobnicate the quux" has no evidence either', route('frobnicate the quux').decision === 'none');

    const belowFloor = route('the time of my life');
    check('sub-threshold keyword noise is "none", not weak',
        belowFloor.decision === 'none' && belowFloor.score === 0.2 &&
        belowFloor.skill === null);
    check('sub-threshold evidence is still reported for debugging',
        candidateNames(belowFloor).includes('datetime'));

    const spread = route('add a note about the script');
    check('a three-way sub-threshold spread does not claim any skill',
        spread.decision === 'none' && spread.skill === null && spread.candidates.length === 3);
}

console.log('\n5) Determinism, order independence and side-effect freedom');
{
    const corpus = [
        '2 + 2', 'what is 150 plus 75?', 'read the current page', 'delete my note',
        'find the latest error in the code', 'add two numbers', 'the weather seems nice today',
        'hello there friend', 'the time of my life', 'turn on the light'
    ];

    const first = corpus.map(t => project(route(t)));
    let repeats = true;
    for (let i = 0; i < 4; i++) {
        corpus.forEach((t, idx) => { if (project(route(t)) !== first[idx]) repeats = false; });
    }
    check('repeated evaluation of the same input is identical (interleaved)', repeats === true);

    // Registration order must not influence any decision: a second manager
    // with the skills registered in reverse order decides exactly the same.
    const reordered = new SkillManager();
    const skillsBefore = reordered.getSkills();
    const reversedNames = skillsBefore.map(s => s.name).reverse();
    for (const s of skillsBefore) reordered.unregister(s.name);
    for (const s of skillsBefore.slice().reverse()) reordered.register(s);
    check('reverse registration order was applied',
        JSON.stringify(reordered.getSkills().map(s => s.name)) === JSON.stringify(reversedNames));
    check('routing decisions are registration-order independent',
        corpus.every((t, idx) => project(reordered.matchSkill(t)) === first[idx]));
    check('the reordered manager agrees on the ambiguous case too',
        reordered.matchSkill('find the latest error in the code').decision === 'ambiguous');

    const historyBefore = skillManager.getHistory().length;
    const lastBefore = skillManager.getLastSkill();
    corpus.forEach(t => route(t));
    check('route evaluation executes nothing and records no history',
        skillManager.getHistory().length === historyBefore && skillManager.getLastSkill() === lastBefore);

    check('_findSkill agrees with the decision layer',
        skillManager._findSkill('2 + 2') &&
        skillManager._findSkill('2 + 2').name === 'calculator' &&
        skillManager._findSkill('add two numbers') === null);

    const compatible = route('2 + 2');
    check('public matchSkill fields stay backwards compatible',
        typeof compatible.skill.execute === 'function' && compatible.skill.name === 'calculator' &&
        compatible.score === 1 && compatible.skill === skillManager.getSkill('calculator'));
}

console.log('\n6) Disabled skills are excluded from routing');
{
    check('iot matches by default', routed('turn on the light') === 'iot');
    skillManager.setEnabled('iot', false);
    const disabled = route('turn on the light');
    check('disabled iot cannot be a candidate',
        disabled.decision === 'none' && disabled.skill === null &&
        !candidateNames(disabled).includes('iot'));
    check('disabling did not leak into other skills',
        routed('2 + 2') === 'calculator');
    skillManager.setEnabled('iot', true);
    check('re-enabled iot routes again', routed('turn on the light') === 'iot');

    skillManager.setEnabled('vision', false);
    const withoutVision = route('what is in this image');
    check('disabled vision is excluded from the candidate list',
        !candidateNames(withoutVision).includes('vision') &&
        withoutVision.skill && withoutVision.skill.name === 'websearch');
    skillManager.setEnabled('vision', true);
    check('re-enabled vision wins "what is in this image" again',
        routed('what is in this image') === 'vision');
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
