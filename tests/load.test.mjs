// Verify every module in the app imports cleanly (browser globals mocked).
globalThis.localStorage = {
    _d: {}, getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }
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
    createElement() { return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector() { return null; } }; },
    body: { appendChild() {}, removeChild() {} },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};
globalThis.Blob = class { constructor() {} };
globalThis.URL = { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ AbstractText: 'ok' }) });

const files = [
    '../js/config.js', '../js/utils.js', '../js/state.js', '../js/audio.js',
    '../js/wakeword.js', '../js/stt.js', '../js/tts.js', '../js/memory.js',
    '../js/skillManager.js', '../js/skills/calculator.js', '../js/skills/websearch.js',
    '../js/skills/notes.js', '../js/skills/reminders.js', '../js/skills/datetime.js',
    '../js/skills/files.js', '../js/skills/reader.js', '../js/skills/memory.js',
    '../js/skills/vision.js', '../js/skills/browser.js', '../js/skills/dev.js', '../js/skills/iot.js',
    '../js/taskPlanner.js', '../js/permissions.js', '../js/agent.js',
    '../js/ai/planSchema.js', '../js/ai/planValidator.js', '../js/ai/toolDiscovery.js',
    '../js/ai/memoryAdapter.js', '../js/ai/contextBuilder.js', '../js/ai/modelAdapter.js',
    '../js/ai/mockAdapter.js', '../js/ai/aiBrain.js',
    '../js/taskDashboard.js', '../js/settings.js', '../js/notifications.js',
    '../js/proactive.js', '../js/integrations.js',
    '../js/conversation.js', '../js/hud.js',
    '../js/auth.js', '../js/boot.js', '../js/app.js'
];

let ok = 0;
for (const f of files) {
    try {
        await import(f);
        ok++;
    } catch (e) {
        console.log('FAIL', f, '->', e.message);
    }
}
console.log(`Loaded ${ok}/${files.length} modules without import errors`);
process.exit(ok === files.length ? 0 : 1);
