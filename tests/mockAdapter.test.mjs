// Tests for Mock Model Adapter (Phase 6.2 AI Brain Architecture)
globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
};

const { MockAdapter } = await import('../js/ai/mockAdapter.js');
const { ModelAdapter, AIValidationError, AITimeoutError, AICancellationError } = await import('../js/ai/modelAdapter.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS', name); }
    else { fail++; console.log('  FAIL', name); }
}

const adapter = new MockAdapter();

console.log('1) Deterministic output');
adapter.reset();
const res1 = await adapter.generate('research quantum computing and summarize');
const res2 = await adapter.generate('research quantum computing and summarize');
check('adapter returns structured object', !!res1.structured);
check('repeated calls produce identical deterministic outputs', JSON.stringify(res1.structured) === JSON.stringify(res2.structured));
check('plan schema contains goal and steps', res1.structured.goal && Array.isArray(res1.structured.steps));

console.log('2) No network requests / no credentials');
check('adapter requires no API key', typeof adapter._config.apiKey === 'undefined');
check('adapter contains no remote endpoint URL', typeof adapter._config.endpoint === 'undefined');

console.log('3) Timeout handling');
adapter.reset();
adapter.setHang(true);
let timedOut = false;
try {
    await adapter.generate('test timeout', { timeout: 80 });
} catch (e) {
    timedOut = e instanceof AITimeoutError;
}
check('timeout triggers AITimeoutError', timedOut === true);
adapter.reset();

console.log('4) Cancellation handling');
adapter.reset();
adapter.setDelay(500);
const controller = new AbortController();
let cancelled = false;
const promise = adapter.generate('test cancellation', { signal: controller.signal });
setTimeout(() => controller.abort(), 50);
try {
    await promise;
} catch (e) {
    cancelled = e instanceof AICancellationError;
}
check('AbortSignal triggers AICancellationError', cancelled === true);
adapter.reset();

console.log('5) Structured output parsing');
const jsonResult = adapter.parseStructuredOutput('{"goal": "test", "steps": []}');
check('parses valid JSON string', jsonResult.goal === 'test');

const markdownResult = adapter.parseStructuredOutput('Here is your plan:\n```json\n{"goal": "extracted", "steps": []}\n```\nHope this helps!');
check('extracts JSON from markdown code block', markdownResult.goal === 'extracted');

let parseError = false;
try {
    adapter.parseStructuredOutput('<<< Invalid JSON string >>>');
} catch (e) {
    parseError = e instanceof AIValidationError;
}
check('malformed JSON throws AIValidationError', parseError === true);

console.log('6) Optional streaming interface');
adapter.reset();
const chunks = [];
for await (const chunk of adapter.generateStream('research artificial intelligence and document it')) {
    chunks.push(chunk);
}
check('generateStream yields chunks', chunks.length > 0);
check('stream output is valid string', typeof chunks[0] === 'string' && chunks[0].length > 0);

console.log('7) Custom mock hooks');
adapter.reset();
adapter.setMockResponse(/weather/i, { response: 'The weather is sunny.' });
const weatherRes = await adapter.generate('what is the weather today?');
check('custom mock regex response matches', weatherRes.structured.response === 'The weather is sunny.');
adapter.reset();

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
