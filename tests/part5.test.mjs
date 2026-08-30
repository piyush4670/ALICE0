// Part 5 smoke tests (node). Browser globals mocked.
globalThis.localStorage = {
    _d: {}, getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }
};
globalThis.window = {
    speechSynthesis: { cancel() {}, pause() {}, resume() {}, speak() {}, getVoices() { return []; } },
    open() {}, SpeechRecognition: undefined, webkitSpeechRecognition: undefined,
    AudioContext: undefined, webkitAudioContext: undefined
};
globalThis.speechSynthesis = globalThis.window.speechSynthesis;
Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: undefined, permissions: undefined }, configurable: true });
globalThis.document = {
    createElement() { return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return null; }, getContext() { return null; } }; },
    body: { appendChild() {}, removeChild() {}, innerText: 'hello page' },
    title: 'Test Page',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};
globalThis.Blob = class { constructor() {} };
globalThis.URL = { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} };
globalThis.Image = class { set src(v) { this._src = v; } };
globalThis.FileReader = class { readAsDataURL() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ AbstractText: 'ok' }) });

const { skillManager } = await import('../js/skillManager.js');
const { memory } = await import('../js/memory.js');
const { state } = await import('../js/state.js');
const { settings } = await import('../js/settings.js');
const { integrations } = await import('../js/integrations.js');
const { proactive } = await import('../js/proactive.js');
const { permissions } = await import('../js/permissions.js');
const { dev } = await import('../js/skills/dev.js');
const { browserSkill } = await import('../js/skills/browser.js');
const { redact } = await import('../js/utils.js');

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; if (!c) console.log('  FAIL', n); else console.log('  PASS', n); };

console.log('1) Skill/plugin ecosystem');
const skills = skillManager.getSkills();
check('12 skills registered', skills.length === 12);
const names = skills.map(s => s.name);
check('new skills present', ['vision', 'browser', 'dev', 'iot'].every(n => names.includes(n)));
const valid = skillManager.validateSkill(dev);
check('dev skill manifest valid', valid.valid === true);
const bad = skillManager.validateSkill({ name: 'x' });
check('invalid skill rejected', bad.valid === false && bad.errors.length > 0);
const regBad = skillManager.register({ name: 'broken' });
check('register rejects invalid plugin', regBad === false);
check('not added to registry', !skillManager.hasSkill('broken'));

console.log('2) Per-skill enable/disable');
const before = skillManager.matchSkill('turn on the light').skill;
check('iot skill matches by default', before && before.name === 'iot');
skillManager.setEnabled('iot', false);
const after = skillManager.matchSkill('turn on the light').skill;
check('disabled iot no longer matches', !after || after.name !== 'iot');
const byName = await skillManager.executeByName('iot', 'list devices');
check('executeByName blocks disabled skill', byName.success === false);
skillManager.setEnabled('iot', true);
check('re-enabled', skillManager.isEnabled('iot') === true);

console.log('3) Advanced memory');
memory.remember('favorite color', 'blue');
memory.setPreference('units', 'metric');
memory.pinFact('project due Friday');
memory.recordTask('test goal', 'completed', 'done');
const fuzzy = memory.recallFuzzy('favourite colour'); // slight misspelling
check('fuzzy recall finds closest', !!fuzzy && fuzzy.value === 'blue');
check('preference stored', memory.getPreference('units') === 'metric');
check('pinned fact stored', memory.getPinnedFacts().length === 1);
check('task history recorded', memory.getTaskHistory().length >= 1);
const prefs = memory.getAllPreferences();
check('preferences retrievable', prefs.units === 'metric');

console.log('4) Settings persistence + apply');
settings.init();
check('defaults loaded', settings.proactiveLevel() === 'moderate');
settings.set('proactive', 'level', 'high');
check('level updated', settings.proactiveLevel() === 'high');
settings.setSkillEnabled('calculator', false);
check('calculator disabled via settings', skillManager.isEnabled('calculator') === false);
settings.setSkillEnabled('calculator', true);

console.log('5) Integrations layer');
const devices = integrations.listDevices();
check('mock devices registered', devices.length >= 3);
const lights = integrations.findDevices('light');
check('lights found', lights.length >= 1);
const r = await integrations.invoke(lights[0].id, 'on');
check('light turned on', r.success === true);
check('light state on', integrations.getDevice(lights[0].id).state.on === true);
const sensor = integrations.findDevices('sensor')[0];
const sr = await integrations.invoke(sensor.id, 'getValue');
check('sensor read', sr.success === true);
const badDev = await integrations.invoke('nope', 'on');
check('unknown device errors clearly', badDev.success === false);

console.log('6) Developer mode heuristics');
const issues = dev._detectIssues('function foo() { if (x = 5) { console.log("x"); }\nvar y = 3;');
check('detects assignment-in-condition', issues.some(i => /assignment/.test(i.message)));
check('detects var usage', issues.some(i => /var/.test(i.message)));
const balanced = dev._detectIssues('function ok() { return 1; }');
check('clean code has no issues', balanced.length === 0);

console.log('7) Security — log redaction');
const dirty = 'api_key=sk-live-1234567890ABCDEF token=abc123456789012345678901234567890';
const clean = redact(dirty);
check('api key redacted', !/sk-live/.test(clean));
check('long token redacted', !/23456789012345678901234567890/.test(clean));
state.logActivity(`connecting with api_key=sk-secret-12345678`);
check('activity log redacted', !/sk-secret/.test(state.get('activityLog')[0].message));

console.log('8) Permissions on new sensitive skills');
check('browser skill risk=medium', browserSkill.risk === 'medium');
check('external send requires confirmation', permissions.evaluateStep({ skill: 'files', action: 'send the document', label: 'files' }).requiresConfirmation === true);
check('iot toggle requires confirmation', permissions.evaluateStep({ skill: 'iot', action: 'turn on the light', label: 'iot', risk: 'sensitive' }).requiresConfirmation === true);
check('vision analyze is safe', permissions.evaluateStep({ skill: 'vision', action: 'analyze image', label: 'vision', risk: 'safe' }).requiresConfirmation === false);

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
