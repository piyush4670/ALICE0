// Calculator routing regression (run with node). Not part of the app.
//
// Regression for the routing bug in which the calculator skill declared
// /what is\s+/i as a trigger, so ANY request beginning with "what is" was
// classified as a calculation. Knowledge questions such as
//
//     "What is the capital of India?"
//     "What is quantum computing?"
//     "What is photosynthesis?"
//
// therefore never reached the knowledge/search path — they were answered by
// the calculator with "Could not understand the calculation".
//
// The rule under test: mathematical CONTENT decides, framing words do not.
//   * an arithmetic expression (operand operator operand) => calculator
//   * a math keyword (calculate / percent of / square root / sqrt) => calculator
//   * "what is ..." with no arithmetic => NOT the calculator
//   * numbers that merely appear in prose => NOT the calculator
//
// Deterministic: no network, no credentials, no real timers. Same plain-node
// + mocked-browser-globals style as the other suites in this directory.

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
    body: { appendChild() {}, removeChild() {}, innerText: 'calculator routing test' },
    title: 'Calculator Routing Test',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};

const { calculator } = await import('../js/skills/calculator.js');
const { skillManager } = await import('../js/skillManager.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

/** Does the calculator's own pattern list claim this text? */
function matchesCalculator(text) {
    return calculator.patterns.some(p => p.test(text.toLowerCase()));
}

/** Which skill does the real routing path (skillManager) pick? */
function routedSkill(text) {
    const { skill } = skillManager.matchSkill(text);
    return skill ? skill.name : null;
}

console.log('1) Calculator registration and trigger specificity');
check('calculator is a registered, valid skill',
    skillManager.hasSkill('calculator') &&
    skillManager.validateSkill(calculator).valid === true);
check('calculator declares a non-empty pattern list',
    Array.isArray(calculator.patterns) && calculator.patterns.length > 0);
check('a bare "what is" prefix is NOT a calculator trigger',
    matchesCalculator('what is') === false);
check('a bare "how much is" prefix is NOT a calculator trigger',
    matchesCalculator('how much is') === false);
check('the calculator does not depend on the phrase "what is"',
    matchesCalculator('2 + 2') === true && matchesCalculator('what is') === false);

console.log('\n2) Legitimate calculator queries still match');
// [input, human label]
const MATH = [
    ['2 + 2', 'symbol addition'],
    ['calculate 25 * 4', 'explicit calculate verb'],
    ['what is 10 plus 5', 'word addition'],
    ['what is 20 divided by 4', 'word division'],
    ['15 percent of 200', 'percentage'],
    ['square root of 144', 'square root'],
    ['10 times 8', 'word multiplication'],
    ['how much is 12 * 7', 'how-much-is framing with symbols'],
    ['10 multiplied by 5', 'word "multiplied by"'],
    ['5 ^ 3', 'power operator'],
    ['3.5 * 2', 'decimals'],
    ['what is 1000 - 1', 'symbol subtraction'],
    ['how much is $20 plus $5', 'currency operands'],
    ['sqrt 16', 'sqrt keyword'],
    ['cube root of 27', 'cube root'],
    // Commands documented in README.md → "Calculator Commands".
    ['Calculate 25 percent of 800', 'documented command'],
    ['What is 150 plus 75?', 'documented command'],
    ["What's 50 times 12?", 'documented command (contracted what\'s)']
];
for (const [input, label] of MATH) {
    check(`matches calculator: ${label} — "${input}"`, matchesCalculator(input) === true);
}

console.log('\n3) General knowledge questions are NOT calculations');
const KNOWLEDGE = [
    ['What is the capital of India?', 'capital question'],
    ['What is quantum computing?', 'concept question'],
    ['What is photosynthesis?', 'concept question (no article)'],
    ['What is the population of India?', 'statistic question'],
    ['What year was India independent?', 'history question'],
    ['What is the population of India in 2024?', 'numbers in prose are not arithmetic'],
    ['What is 1947 known for?', 'lone number is not arithmetic'],
    ['tell me about the 3 laws of robotics', 'number in prose'],
    ['how much is the rent in Mumbai', 'how-much-is without arithmetic'],
    ['what is the percentage of users who like dark mode', 'percent without operands']
];
for (const [input, label] of KNOWLEDGE) {
    check(`not calculator: ${label} — "${input}"`, matchesCalculator(input) === false);
}

console.log('\n4) End-to-end routing through skillManager');
check('"2 + 2" routes to calculator', routedSkill('2 + 2') === 'calculator');
check('"calculate 25 * 4" routes to calculator', routedSkill('calculate 25 * 4') === 'calculator');
check('"what is 10 plus 5" routes to calculator', routedSkill('what is 10 plus 5') === 'calculator');
check('"what is 20 divided by 4" routes to calculator', routedSkill('what is 20 divided by 4') === 'calculator');
check('"15 percent of 200" routes to calculator', routedSkill('15 percent of 200') === 'calculator');
check('"square root of 144" routes to calculator', routedSkill('square root of 144') === 'calculator');
check('"10 times 8" routes to calculator', routedSkill('10 times 8') === 'calculator');
check('"Calculate 25 percent of 800" routes to calculator (README command)',
    routedSkill('Calculate 25 percent of 800') === 'calculator');
check('"What is 150 plus 75?" routes to calculator (README command)',
    routedSkill('What is 150 plus 75?') === 'calculator');
check('"What\'s 50 times 12?" routes to calculator (README command)',
    routedSkill("What's 50 times 12?") === 'calculator');

const NOT_CALCULATOR = [
    'What is the capital of India?',
    'What is quantum computing?',
    'What is photosynthesis?',
    'What is the population of India?',
    'What year was India independent?'
];
for (const input of NOT_CALCULATOR) {
    check(`"${input}" is not routed to calculator`, routedSkill(input) !== 'calculator');
}
check('knowledge questions reach the knowledge/search skill',
    NOT_CALCULATOR.filter(i => routedSkill(i) === 'websearch').length >= 3);

console.log('\n5) Existing calculator computation is preserved');
const RESULTS = [
    ['2 + 2', 4],
    ['calculate 25 * 4', 100],
    ['what is 10 plus 5', 15],
    ['what is 20 divided by 4', 5],
    ['15 percent of 200', 30],
    ['10 times 8', 80],
    ['5 ^ 3', 125],
    ['how much is $20 plus $5', 25],
    ['what is 1000 - 1', 999],
    ['Calculate 25 percent of 800', 200],
    ['What is 150 plus 75?', 225],
    ["What's 50 times 12?", 600]
];
for (const [input, expected] of RESULTS) {
    const r = calculator.execute(input);
    check(`execute("${input}") = ${expected}`,
        r.success === true && r.value === expected);
}
check('unparsable input still fails gracefully',
    calculator.execute('What is the capital of India?').success === false);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
