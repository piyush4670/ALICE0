// Tests for AI Brain (Phase 6.2 AI Brain Architecture)
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

const { aiBrain } = await import('../js/ai/aiBrain.js');
const { MockAdapter } = await import('../js/ai/mockAdapter.js');
const { state } = await import('../js/state.js');
const { memory } = await import('../js/memory.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

const adapter = aiBrain.getAdapter();

console.log('1) AI Brain accepts request & returns structured plan');
adapter.reset();
const res1 = await aiBrain.processRequest('research quantum computing, summarize the important information and create a document');
check('processRequest returns success: true', res1.success === true);
check('processRequest detects multi-step task', res1.isMultiStep === true);
check('plan contains 3 steps', Array.isArray(res1.plan) && res1.plan.length === 3);
check('step 1 binds websearch', res1.plan[0].skill === 'websearch');
check('step 2 binds core summarize', res1.plan[1].skill === 'core' && res1.plan[1].operation === 'summarize');
check('step 3 binds files create', res1.plan[2].skill === 'files' && res1.plan[2].action === 'create');

console.log('2) AI Brain handles empty input');
const resEmpty1 = await aiBrain.processRequest('');
check('empty string returns success: false', resEmpty1.success === false);
check('empty string returns safe message', /provide a request/i.test(resEmpty1.response));

const resEmpty2 = await aiBrain.processRequest('   ');
check('whitespace string returns success: false', resEmpty2.success === false);

const resEmpty3 = await aiBrain.processRequest(null);
check('null input returns success: false', resEmpty3.success === false);

console.log('3) AI Brain handles model failure gracefully');
adapter.reset();
adapter.setFailure(true, new Error('Simulated upstream API outage'));
const resFail = await aiBrain.processRequest('research artificial intelligence');
check('model failure returns success: false', resFail.success === false);
check('fallback flag is set to true', resFail.fallback === true);
check('error is captured safely', /outage/i.test(resFail.error));
adapter.reset();

console.log('4) AI Brain handles timeout cleanly');
adapter.reset();
adapter.setHang(true);
const resTimeout = await aiBrain.processRequest('research fusion energy', { timeout: 100 });
check('timeout returns success: false', resTimeout.success === false);
check('fallback flag is set on timeout', resTimeout.fallback === true);
check('timeout error code identified', resTimeout.code === 'AI_TIMEOUT' || /timed out/i.test(resTimeout.error));
adapter.reset();

console.log('5) AI Brain handles malformed model output');
adapter.reset();
adapter.setMalformedOutput(true);
const resMalformed = await aiBrain.processRequest('research robotics and summarize');
check('malformed output returns success: false', resMalformed.success === false);
check('fallback flag is set on malformed output', resMalformed.fallback === true);
adapter.reset();

console.log('6) AI Brain response generation');
const synthRes = await aiBrain.generateResponse('what did you do?', { response: 'Researched quantum computing' });
check('generateResponse returns a string', typeof synthRes === 'string' && synthRes.length > 0);

console.log('7) AI Brain enabled/disabled feature toggle');
aiBrain.setEnabled(false);
check('isEnabled() reports false', aiBrain.isEnabled() === false);
const resDisabled = await aiBrain.processRequest('research quantum computing');
check('disabled brain returns success: false', resDisabled.success === false);
check('disabled flag set', resDisabled.disabled === true);
check('fallback flag set', resDisabled.fallback === true);
aiBrain.setEnabled(true);
check('re-enabled reports true', aiBrain.isEnabled() === true);

console.log('8) Tool discovery & context building');
const tools = aiBrain.getToolDiscovery().getToolDefinitions();
check('tool discovery exposes safe tools', Array.isArray(tools) && tools.length >= 10);
check('tool descriptors do not leak execute functions', tools.every(t => typeof t.execute === 'undefined'));
check('tool descriptors do not leak pattern regexes', tools.every(t => typeof t.patterns === 'undefined'));

memory.pinFact('The user prefers dark mode');
const ctx = aiBrain.getContextBuilder().buildContext({ request: 'tell me about my settings' });
check('context builder includes user request', ctx.request === 'tell me about my settings');
check('context builder includes pinned memory', ctx.memory.pinnedFacts.some(f => /dark mode/.test(f.text)));
check('context builder includes tools', ctx.tools.length > 0);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
