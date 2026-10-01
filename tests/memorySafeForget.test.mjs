// Safe memory forgetting regression test suite (Part 10.3).
// Run with node: `node tests/memorySafeForget.test.mjs`
//
// Covers: exact-key deletion, unambiguous partial matches through the
// confirmation flow, ambiguous / missing / empty targets, target-bound
// approvals, and change-or-disappearance detection while a confirmation is
// pending — plus the remember/recall/search behaviour that must not regress.

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

globalThis.document = {
    createElement() {
        return { style: {}, setAttribute() {}, click() {}, classList: { add() {}, remove() {} }, appendChild() {}, removeChild() {}, querySelector() { return null; } };
    },
    body: { appendChild() {}, removeChild() {}, innerText: '' },
    title: 'Test',
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}
};

const { skillManager } = await import('../js/skillManager.js');
const { permissions } = await import('../js/permissions.js');
const { memorySkill } = await import('../js/skills/memory.js');
const { memory } = await import('../js/memory.js');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) {
        pass++;
        console.log('  PASS', name);
    } else {
        fail++;
        console.error('  FAIL', name);
    }
}

// Confirmation harness
let promptCount = 0;
let lastMeta = null;
let autoMode = 'approve'; // 'approve' | 'deny' | null (manual)

permissions.onPrompt((meta) => {
    promptCount++;
    lastMeta = meta;
    if (autoMode === 'approve') {
        setTimeout(() => permissions.answer(true, meta.id), 0);
    } else if (autoMode === 'deny') {
        setTimeout(() => permissions.answer(false, meta.id), 0);
    }
});

function clearAllMemories() {
    for (const m of memory.getAllMemories()) {
        memory.forget(m.key);
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

console.log('1) Exact-key deletion remains functional');
{
    clearAllMemories();
    memory.remember('favorite color', 'green');
    memory.remember('dog', 'Rex');

    // 1a) Denied exact-key deletion leaves the memory intact
    promptCount = 0;
    autoMode = 'deny';
    const denied = await skillManager.executeByName('memory', 'forget my favorite color');
    check('denied exact-key deletion returns success: false', denied.success === false);
    check('denied exact-key deletion is marked cancelled', denied.cancelled === true);
    check('denied exact-key deletion reports decision: denied', denied.permission?.decision === 'denied');
    check('memory survives denial', memory.recall('favorite color') === 'green');
    check('denial prompted exactly once', promptCount === 1);

    // 1b) Approved exact-key deletion removes exactly that memory
    promptCount = 0;
    autoMode = 'approve';
    const approved = await skillManager.executeByName('memory', 'forget my favorite color');
    check('approved exact-key deletion returns success: true', approved.success === true);
    check('approved exact-key deletion returns a result message', typeof approved.result === 'string' && approved.result.includes('favorite color'));
    check('the exact memory was deleted', memory.hasMemory('favorite color') === false);
    check('an unrelated memory was not deleted', memory.recall('dog') === 'Rex');
    check('approval prompted exactly once', promptCount === 1);

    // 1c) Exact-key deletion is case/whitespace tolerant like the rest of memory
    promptCount = 0;
    autoMode = 'approve';
    const approvedUpper = await skillManager.executeByName('memory', 'forget my DOG');
    check('uppercase exact-key deletion succeeds', approvedUpper.success === true);
    check('uppercase exact key deleted the stored memory', memory.hasMemory('dog') === false);
    check('no memories left', memory.getAllMemories().length === 0);
}

console.log('2) One unambiguous partial match follows the safe confirmation flow');
{
    clearAllMemories();
    memory.remember('dog', 'Rex');
    memory.remember('car', 'blue');

    // "Rex" is not a key — it matches a single memory by value.
    check('the search term is not an exact key', memory.hasMemory('Rex') === false);

    // 2a) Denial prevents deletion
    promptCount = 0;
    autoMode = 'deny';
    const denied = await skillManager.executeByName('memory', 'forget my Rex');
    check('denied partial-match deletion returns success: false', denied.success === false);
    check('denied partial-match deletion is marked cancelled', denied.cancelled === true);
    check('denied partial-match deletion reports decision: denied', denied.permission?.decision === 'denied');
    check('memory survives denial', memory.recall('dog') === 'Rex');
    check('denial prompted exactly once', promptCount === 1);

    // 2b) Approval deletes the resolved memory only
    promptCount = 0;
    autoMode = 'approve';
    const approved = await skillManager.executeByName('memory', 'forget my Rex');
    check('approved partial-match deletion returns success: true', approved.success === true);
    check('result names the memory that was forgotten',
        typeof approved.result === 'string' && /dog/i.test(approved.result) && /Rex/.test(approved.result));
    check('the resolved memory was deleted', memory.hasMemory('dog') === false);
    check('the other memory is untouched', memory.recall('car') === 'blue');
    check('approval prompted exactly once', promptCount === 1);
}

console.log('3) Multiple partial matches request clarification and delete nothing');
{
    clearAllMemories();
    memory.remember('car color', 'blue');
    memory.remember('car model', 'Model 3');

    promptCount = 0;
    autoMode = 'approve';
    const res = await skillManager.executeByName('memory', 'forget my car');

    check('ambiguous request reports success: false', res.success === false);
    check('no memory was deleted', memory.getAllMemories().length === 2);
    check('first match was NOT silently deleted', memory.recall('car color') === 'blue');
    check('second match was NOT deleted', memory.recall('car model') === 'Model 3');

    const errorMsg = res.error || '';
    check('clarification states that nothing was deleted', /didn't delete anything/i.test(errorMsg));
    check('clarification identifies the car color key', errorMsg.includes('car color'));
    check('clarification identifies the car model key', errorMsg.includes('car model'));
    check('clarification shows a value preview to tell them apart',
        errorMsg.includes('blue') && errorMsg.includes('Model 3'));
    check('clarification asks for the exact key', /exact key/i.test(errorMsg));
    check('matches array contains both memories', Array.isArray(res.matches) && res.matches.length === 2);
    check('matches array carries the keys',
        Array.isArray(res.matches) && res.matches.map(m => m.key).sort().join(',') === 'car color,car model');

    // Three matching memories
    memory.remember('car year', '2019');
    promptCount = 0;
    const res3 = await skillManager.executeByName('memory', 'forget my car');
    check('three matches report success: false', res3.success === false);
    check('three matches list all three keys', Array.isArray(res3.matches) && res3.matches.length === 3);
    check('all three memories survive', memory.getAllMemories().length === 3);

    // An approval memoized for an ambiguous request still deletes nothing
    const resAgain = await skillManager.executeByName('memory', 'forget my car');
    check('a repeated ambiguous request still deletes nothing', resAgain.success === false && memory.getAllMemories().length === 3);
}

console.log('4) No match (and empty target) deletes nothing');
{
    clearAllMemories();
    memory.remember('dog', 'Rex');

    promptCount = 0;
    autoMode = 'approve';
    const resZero = await skillManager.executeByName('memory', 'forget my NonExistentTopic12345');
    check('zero matches report success: false', resZero.success === false);
    check('zero matches report a useful message',
        /don't have anything saved/i.test(resZero.error) && resZero.error.includes('NonExistentTopic12345'));
    check('existing memory was not deleted', memory.recall('dog') === 'Rex');

    // Empty target
    promptCount = 0;
    autoMode = 'approve';
    const resEmpty = await skillManager.executeByName('memory', 'forget my');
    check('empty target reports success: false', resEmpty.success === false);
    check('empty target asks what to forget', /what would you like me to forget/i.test(resEmpty.error));
    check('existing memory survives an empty target', memory.recall('dog') === 'Rex');

    // Bare command
    promptCount = 0;
    autoMode = 'approve';
    const resBare = await skillManager.executeByName('memory', 'forget');
    check('bare forget command reports success: false', resBare.success === false);
    check('bare forget command asks what to forget', /what would you like me to forget/i.test(resBare.error));
    check('existing memory survives a bare forget command', memory.recall('dog') === 'Rex');
}

console.log('5) An approval for one memory cannot delete a different memory');
{
    clearAllMemories();
    memory.remember('dog', 'Rex');
    memory.remember('cat', 'Whiskers');

    promptCount = 0;
    autoMode = 'approve';
    const r1 = await skillManager.executeByName('memory', 'forget my dog');
    check('first deletion approved and executed', r1.success === true);
    check('the approved memory was deleted', memory.hasMemory('dog') === false);
    check('the other memory still exists', memory.recall('cat') === 'Whiskers');
    check('first deletion prompted once', promptCount === 1);

    promptCount = 0;
    autoMode = 'deny';
    const r2 = await skillManager.executeByName('memory', 'forget my cat');
    check('the second deletion is gated, not bypassed by the earlier approval', r2.success === false);
    check('the earlier approval did NOT delete the other memory', memory.hasMemory('cat') === true);
    check('the second deletion prompted for confirmation', promptCount === 1);

    // The same sentence resolving to a different memory must be re-gated
    clearAllMemories();
    memory.remember('dog', 'Rex');
    memory.remember('dog name', 'Rexy');

    promptCount = 0;
    autoMode = 'approve';
    const rExact = await skillManager.executeByName('memory', 'forget my dog');
    check('exact key deletion removed only the exact key', rExact.success === true &&
        memory.hasMemory('dog') === false && memory.hasMemory('dog name') === true);

    promptCount = 0;
    autoMode = 'deny';
    const rSameSentence = await skillManager.executeByName('memory', 'forget my dog');
    check('the same sentence now resolving to another memory is gated again', rSameSentence.success === false);
    check('the newly resolved memory was not deleted', memory.recall('dog name') === 'Rexy');
    check('the re-resolved target prompted for confirmation', promptCount === 1);
}

console.log('6) A memory changed while confirmation is pending is not deleted');
{
    // 6a) Gateway path (skillManager.executeByName)
    clearAllMemories();
    memory.remember('dog', 'Rex');

    promptCount = 0;
    autoMode = null; // manual confirmation
    const pending = skillManager.executeByName('memory', 'forget my dog');
    await sleep(10);
    check('gateway confirmation prompt opened', permissions.hasPending() === true);
    const promptMeta = permissions.getPendingMeta();

    // Change the memory while confirmation is pending
    memory.remember('dog', 'Max');
    check('memory was changed while confirmation was pending', memory.recall('dog') === 'Max');

    permissions.answer(true, promptMeta.id);
    const res = await pending;
    check('deletion of a changed memory was aborted', res.success === false);
    check('error explains that the memory changed and needs review', /changed.*review/i.test(res.error));
    check('error states that nothing was deleted', /didn't delete anything/i.test(res.error));
    check('the memory still exists', memory.hasMemory('dog') === true);
    check('the new value is preserved', memory.recall('dog') === 'Max');
    check('no prompt left dangling after the abort', permissions.hasPending() === false);

    // 6b) Direct execution path (memorySkill.execute without the gateway)
    clearAllMemories();
    memory.remember('project', 'Apollo');

    promptCount = 0;
    autoMode = null;
    const pendingDirect = memorySkill.execute('forget my project');
    await sleep(10);
    check('direct confirmation prompt opened', permissions.hasPending() === true);
    const directMeta = permissions.getPendingMeta();

    memory.remember('project', 'Zeus');
    permissions.answer(true, directMeta.id);
    const resDirect = await pendingDirect;
    check('direct deletion of a changed memory was aborted', resDirect.success === false);
    check('direct error explains the memory changed', /changed.*review/i.test(resDirect.error));
    check('direct path keeps the new value', memory.recall('project') === 'Zeus');

    // 6c) After an abort the flow recovers: a later, freshly confirmed request works
    promptCount = 0;
    autoMode = 'approve';
    const recovered = await skillManager.executeByName('memory', 'forget my project');
    check('a freshly confirmed deletion after an abort succeeds', recovered.success === true);
    check('the memory is deleted after the fresh confirmation', memory.hasMemory('project') === false);
}

console.log('7) A memory removed while confirmation is pending is handled safely');
{
    // 7a) Gateway path
    clearAllMemories();
    memory.remember('dog', 'Rex');
    memory.remember('cat', 'Whiskers');

    promptCount = 0;
    autoMode = null;
    const pending = skillManager.executeByName('memory', 'forget my dog');
    await sleep(10);
    check('confirmation prompt opened for the pending deletion', permissions.hasPending() === true);
    const promptMeta = permissions.getPendingMeta();

    // Remove the memory while confirmation is pending
    memory.forget('dog');
    check('the memory was removed while confirmation was pending', memory.hasMemory('dog') === false);

    permissions.answer(true, promptMeta.id);
    const res = await pending;
    check('deletion of a disappeared memory is aborted', res.success === false);
    check('error indicates the memory disappeared', /disappeared/i.test(res.error));
    check('error asks the user to review the request again', /review the request again/i.test(res.error));
    check('nothing else was deleted', memory.recall('cat') === 'Whiskers');
    check('no prompt left dangling after the abort', permissions.hasPending() === false);

    // 7b) Direct execution path
    clearAllMemories();
    memory.remember('project', 'Apollo');

    promptCount = 0;
    autoMode = null;
    const pendingDirect = memorySkill.execute('forget my project');
    await sleep(10);
    const directMeta = permissions.getPendingMeta();
    memory.forget('project');
    permissions.answer(true, directMeta.id);
    const resDirect = await pendingDirect;
    check('direct deletion of a disappeared memory is aborted safely', resDirect.success === false);
    check('direct error indicates the memory disappeared', /disappeared/i.test(resDirect.error));

    // 7d) The request resolving to a DIFFERENT memory after confirmation must not delete it
    clearAllMemories();
    memory.remember('dog', 'Rex');

    promptCount = 0;
    autoMode = null;
    const pendingSwapped = skillManager.executeByName('memory', 'forget my dog');
    await sleep(10);
    const swappedMeta = permissions.getPendingMeta();

    // The confirmed memory disappears and another one now matches the request
    memory.forget('dog');
    memory.remember('dog name', 'Rexy');

    permissions.answer(true, swappedMeta.id);
    const resSwapped = await pendingSwapped;
    check('a request that now resolves to another memory deletes nothing', resSwapped.success === false);
    check('error explains the request no longer matches the confirmed memory',
        /no longer matches.*review/i.test(resSwapped.error));
    check('the newly matching memory was not deleted', memory.recall('dog name') === 'Rexy');

    // 7e) The consumed approval cannot be reused to delete another memory
    clearAllMemories();
    memory.remember('project', 'Apollo');
    promptCount = 0;
    autoMode = 'approve';
    const first = await skillManager.executeByName('memory', 'forget my project');
    check('first approved deletion succeeded', first.success === true && memory.hasMemory('project') === false);

    memory.remember('project', 'Apollo 2');
    promptCount = 0;
    autoMode = 'deny';
    const second = await skillManager.executeByName('memory', 'forget my project');
    check('a reused sentence cannot delete a re-created memory without consent', second.success === false);
    check('the re-created memory is intact', memory.recall('project') === 'Apollo 2');
    check('the second request prompted for confirmation', promptCount === 1);
}

console.log('8) Direct execution without a gateway approval still requires confirmation');
{
    clearAllMemories();
    memory.remember('dog', 'Rex');

    promptCount = 0;
    autoMode = 'deny';
    const denied = await memorySkill.execute('forget my dog');
    check('direct execution without approval is gated and denied',
        denied.success === false && denied.cancelled === true);
    check('memory survives the direct denial', memory.recall('dog') === 'Rex');
    check('direct execution prompted exactly once', promptCount === 1);

    promptCount = 0;
    autoMode = 'approve';
    const approved = await memorySkill.execute('forget my dog');
    check('direct execution with approval succeeds', approved.success === true);
    check('memory deleted after the direct approval', memory.hasMemory('dog') === false);

    // The end-to-end routing path (skillManager.process) is safe too
    clearAllMemories();
    memory.remember('car color', 'blue');
    memory.remember('car model', 'Model 3');
    promptCount = 0;
    autoMode = 'approve';
    const routed = await skillManager.process('forget my car');
    check('routed ambiguous request deletes nothing',
        routed.success === false && memory.getAllMemories().length === 2);
}

console.log('9) Existing remember, recall, and search behavior remains intact');
{
    clearAllMemories();

    const resRemember = await memorySkill.execute('remember that my favorite color is green');
    check('remember succeeds', resRemember.success === true);
    check('remember stores the value', memory.recall('favorite color') === 'green');
    check('remember returns the confirmation message',
        typeof resRemember.result === 'string' && resRemember.result.includes('green'));

    const resRememberShort = await memorySkill.execute('remember that my dog is Rex');
    check('second remember succeeds', resRememberShort.success === true);
    check('second remember stores the value', memory.recall('dog') === 'Rex');

    const resRecall = await memorySkill.execute('do you remember my favorite color');
    check('exact recall succeeds', resRecall.success === true);
    check('exact recall returns the stored value', /green/.test(resRecall.result));

    const resFuzzyRecall = await memorySkill.execute('tell me about my favourite colour');
    check('fuzzy recall succeeds', resFuzzyRecall.success === true);
    check('fuzzy recall finds the closest memory', /green/.test(resFuzzyRecall.result));

    const resList = await memorySkill.execute('what do i know ');
    check('listing all memories succeeds', resList.success === true);
    check('listing includes both memories',
        resList.result.includes('favorite color') && resList.result.includes('dog'));

    const resMissingRecall = await memorySkill.execute('do you remember my spaceship');
    check('recall of an unknown key reports failure', resMissingRecall.success === false);
    check('recall of an unknown key offers to remember it', /would you like me to remember/i.test(resMissingRecall.error));

    // Low-level memory API is unchanged
    check('memory.hasMemory works', memory.hasMemory('dog') === true && memory.hasMemory('nope') === false);
    check('memory.search still ranks matches', memory.search('favorite').length === 1);
    check('memory.recallFuzzy still resolves the closest memory',
        (() => { const f = memory.recallFuzzy('favourite colour'); return !!f && f.value === 'green'; })());
    check('memory.forget still works directly', memory.forget('dog') === true && memory.hasMemory('dog') === false);

    // Routing and the unknown-command path are untouched
    const resUnknown = await memorySkill.execute('realign the flux capacitor');
    check('an unrecognized memory command reports failure', resUnknown.success === false);
    check('skill routing still selects the memory skill for a forget request',
        skillManager.matchSkill('forget my car').skill?.name === 'memory');
}

console.log('10) A partial-value target that disappears during confirmation cannot be deleted by a retry');
{
    clearAllMemories();
    memory.remember('dog', 'Rex');

    // "Rex" is a VALUE match, so the resolved key ("dog") differs from the
    // search phrase — approvals must still be invalidated for that key.
    promptCount = 0;
    autoMode = null; // manual confirmation
    const pending = skillManager.executeByName('memory', 'forget my Rex');
    await sleep(10);
    check('confirmation prompt opened for the partial-value target', permissions.hasPending() === true);
    const meta = permissions.getPendingMeta();

    // The target disappears while confirmation is pending
    memory.forget('dog');
    check('the target memory is gone while confirmation is pending', memory.hasMemory('dog') === false);

    permissions.answer(true, meta.id);
    const res = await pending;
    check('the vanished target is reported as disappeared, not deleted silently',
        res.success === false && /disappeared/i.test(res.error));

    // Recreate the memory and retry the same sentence inside the memo window
    memory.remember('dog', 'Rex');
    check('the memory was recreated', memory.recall('dog') === 'Rex');

    promptCount = 0;
    autoMode = 'deny';
    const retry = await skillManager.executeByName('memory', 'forget my Rex');
    check('the retry requires a fresh approval (it prompts again)', promptCount === 1);
    check('the stale approval did not delete the recreated memory',
        retry.success === false && memory.recall('dog') === 'Rex');

    // The same retry, freshly approved, still works
    promptCount = 0;
    autoMode = 'approve';
    const approvedRetry = await skillManager.executeByName('memory', 'forget my Rex');
    check('a freshly approved retry deletes the recreated memory',
        approvedRetry.success === true && memory.hasMemory('dog') === false);
}

console.log('11) A target that becomes ambiguous during confirmation cannot be deleted by a retry');
{
    clearAllMemories();
    memory.remember('dog', 'Rex');

    promptCount = 0;
    autoMode = null; // manual confirmation
    const pending = skillManager.executeByName('memory', 'forget my Rex');
    await sleep(10);
    check('confirmation prompt opened before the request became ambiguous', permissions.hasPending() === true);
    const meta = permissions.getPendingMeta();

    // A second memory starts matching the very same request
    memory.remember('dog name', 'Rexy');
    check('the request became ambiguous while confirmation was pending', memory.search('Rex').length === 2);

    permissions.answer(true, meta.id);
    const res = await pending;
    check('an ambiguous target deletes nothing', res.success === false && /didn't delete anything/i.test(res.error));
    check('both memories are intact', memory.recall('dog') === 'Rex' && memory.recall('dog name') === 'Rexy');

    // A retry that resolves to the previously confirmed key must be re-gated
    promptCount = 0;
    autoMode = 'deny';
    const retryExact = await skillManager.executeByName('memory', 'forget my dog');
    check('the previously confirmed key is re-gated, not deleted by the stale approval',
        retryExact.success === false);
    check('the retry prompted for a fresh approval', promptCount === 1);
    check('the memory survived the denied retry', memory.recall('dog') === 'Rex');

    // Retrying the same ambiguous sentence is gated as well
    promptCount = 0;
    autoMode = 'deny';
    const retryAmbig = await skillManager.executeByName('memory', 'forget my Rex');
    check('the ambiguous retry is gated too', retryAmbig.success === false);
    check('the ambiguous retry prompted for a fresh approval', promptCount === 1);
    check('neither retry deleted anything', memory.getAllMemories().length === 2);

    // A clarified request, freshly approved, still deletes exactly one memory
    promptCount = 0;
    autoMode = 'approve';
    const clarified = await skillManager.executeByName('memory', 'forget my dog name');
    check('a clarified, freshly approved deletion succeeds', clarified.success === true);
    check('only the named memory was deleted',
        memory.hasMemory('dog name') === false && memory.recall('dog') === 'Rex');
}

console.log('12) Existing safe deletion and recall behavior remain intact');
{
    clearAllMemories();
    memory.remember('favorite color', 'green');
    memory.remember('car color', 'blue');
    memory.remember('car model', 'Model 3');

    // Exact-key deletion still deletes only the named memory
    promptCount = 0;
    autoMode = 'approve';
    const exact = await skillManager.executeByName('memory', 'forget my favorite color');
    check('exact-key deletion still succeeds when approved', exact.success === true);
    check('only the named memory was deleted',
        memory.hasMemory('favorite color') === false && memory.hasMemory('car color') === true);
    check('exact-key deletion prompted once', promptCount === 1);

    // An unambiguous partial match still deletes the single match
    promptCount = 0;
    autoMode = 'approve';
    const single = await skillManager.executeByName('memory', 'forget my blue');
    check('a single partial match still deletes when approved', single.success === true);
    check('the single matching memory was deleted', memory.hasMemory('car color') === false);
    check('the other memory is untouched', memory.recall('car model') === 'Model 3');

    // An ambiguous request still deletes nothing
    memory.remember('car year', '2019');
    promptCount = 0;
    autoMode = 'approve';
    const ambiguous = await skillManager.executeByName('memory', 'forget my car');
    check('an ambiguous request still deletes nothing',
        ambiguous.success === false && memory.getAllMemories().length === 2);

    // Recall is unchanged
    const recall = await memorySkill.execute('do you remember my car model');
    check('recall still returns the stored value', recall.success === true && /Model 3/.test(recall.result));
    const fuzzy = await memorySkill.execute('tell me about my car modl');
    check('fuzzy recall still resolves the closest memory', fuzzy.success === true && /Model 3/.test(fuzzy.result));
    check('the stored memory is intact after recalls', memory.recall('car model') === 'Model 3');
    check('the second stored memory is intact too', memory.recall('car year') === '2019');
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
