// Safe note deletion regression test suite.
// Run with node: `node --test tests/notesSafeDelete.test.mjs`

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
const { notes } = await import('../js/skills/notes.js');
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

function clearAllNotes() {
    const all = [...memory.getNotes()];
    for (const n of all) {
        memory.deleteNote(n.id);
    }
}

async function addDistinctNote(title, content) {
    await new Promise((r) => setTimeout(r, 2));
    return memory.addNote(title, content);
}

console.log('1) Ambiguous keyword matches cause no deletion and request clarification');
{
    clearAllNotes();
    const note1 = await addDistinctNote('Project Alpha Roadmap', 'Q3 release goals and deadlines');
    const note2 = await addDistinctNote('Project Alpha Budget', 'Approved costs for Q3');

    promptCount = 0;
    autoMode = 'approve';

    // Attempt to delete with ambiguous keyword "Project Alpha"
    const res = await skillManager.executeByName('notes', 'delete note about Project Alpha');

    check('ambiguous keyword reports success: false', res.success === false);
    check('first note was NOT silently deleted', memory.getNote(note1.id) !== undefined);
    check('second note was NOT deleted', memory.getNote(note2.id) !== undefined);
    check('both notes remain in memory', memory.getNotes().length === 2);

    // Verify clarification response identifies both matching notes
    const errorMsg = res.error || '';
    check('clarification message identifies Project Alpha Roadmap', errorMsg.includes('Project Alpha Roadmap'));
    check('clarification message identifies Project Alpha Budget', errorMsg.includes('Project Alpha Budget'));
    check('clarification mentions multiple notes match', /multiple notes match/i.test(errorMsg));
    check('clarification specifies how to choose (by number or title)', /number|title/i.test(errorMsg));
    check('matches array contains both notes', Array.isArray(res.matches) && res.matches.length === 2);

    // Three matching notes
    const note3 = await addDistinctNote('Project Alpha Retrospective', 'Notes from the sprint review');
    const res3 = await skillManager.executeByName('notes', 'delete note about Project Alpha');
    check('three matches report success: false', res3.success === false);
    check('three matches contain all 3 notes', Array.isArray(res3.matches) && res3.matches.length === 3);
    check('all three notes still exist', memory.getNotes().length === 3);
}

console.log('2) Zero matches cause no deletion and return a useful message');
{
    clearAllNotes();
    await addDistinctNote('Shopping List', 'Milk and eggs');

    promptCount = 0;
    autoMode = 'approve';

    // Keyword with no matches
    const resZero = await skillManager.executeByName('notes', 'delete note about NonExistentTopic12345');
    check('zero matches reports success: false', resZero.success === false);
    check('zero matches reports useful message', /no note found matching/i.test(resZero.error) && resZero.error.includes('NonExistentTopic12345'));
    check('existing note was not deleted', memory.searchNotes('Shopping List').length === 1);

    // Note number out of range
    const resNumOutOfRange = await skillManager.executeByName('notes', 'delete note 99');
    check('note number out of range reports success: false', resNumOutOfRange.success === false);
    check('note number out of range error mentions note number 99', resNumOutOfRange.error.includes('99'));
    check('existing note remains intact', memory.getNotes().length === 1);

    // Empty note input
    const resEmpty = await skillManager.executeByName('notes', 'delete my note');
    check('empty input reports success: false', resEmpty.success === false);
    check('empty input asks which note to delete', /which note would you like to delete/i.test(resEmpty.error));
    check('existing note remains intact after empty input', memory.getNotes().length === 1);
}

console.log('3) An unambiguous target can be deleted only through the appropriate existing safety flow');
{
    clearAllNotes();
    const keepNote = await addDistinctNote('Guarded Note', 'Important content');

    // 3a) Denial prevents deletion
    promptCount = 0;
    autoMode = 'deny';
    const resDenied = await skillManager.executeByName('notes', 'delete note about Guarded Note');
    check('denied deletion returns success: false', resDenied.success === false);
    check('denied deletion marked cancelled', resDenied.cancelled === true);
    check('denied deletion reports decision: denied', resDenied.permission?.decision === 'denied');
    check('note survives denial', memory.getNote(keepNote.id) !== undefined);
    check('denial prompted exactly once', promptCount === 1);

    // 3b) Voice cancellation prevents deletion
    promptCount = 0;
    autoMode = null; // manual
    const pendingExec = skillManager.executeByName('notes', 'delete note about Guarded Note');
    await new Promise((r) => setTimeout(r, 10));
    check('confirmation prompt opened for voice answer', permissions.hasPending() === true);
    const voiceResult = permissions.answerVoice('cancel');
    const resVoiceDenied = await pendingExec;
    check('voice "cancel" returned false', voiceResult === false);
    check('voice cancel resulted in decision: denied', resVoiceDenied.permission?.decision === 'denied');
    check('note survives voice cancellation', memory.getNote(keepNote.id) !== undefined);

    // 3c) Approval executes deletion
    promptCount = 0;
    autoMode = 'approve';
    const resApproved = await skillManager.executeByName('notes', 'delete note about Guarded Note');
    check('approved deletion returns success: true', resApproved.success === true);
    check('approved deletion returns result message', typeof resApproved.result === 'string' && resApproved.result.includes('Guarded Note'));
    check('note was actually deleted from memory', memory.getNote(keepNote.id) === undefined);
    check('approval prompted exactly once', promptCount === 1);

    // 3d) Direct execution of notes.execute without prior gateway approval requires confirmation
    clearAllNotes();
    const directNote = await addDistinctNote('Direct Note', 'Created for direct test');
    promptCount = 0;
    autoMode = 'deny';
    const resDirectDenied = await notes.execute('delete note 1');
    check('direct execution without approval was gated and denied', resDirectDenied.success === false && resDirectDenied.cancelled === true);
    check('note survives direct denial', memory.getNote(directNote.id) !== undefined);

    promptCount = 0;
    autoMode = 'approve';
    const resDirectApproved = await notes.execute('delete note 1');
    check('direct execution with approval succeeds', resDirectApproved.success === true);
    check('note deleted after direct approval', memory.getNote(directNote.id) === undefined);
}

console.log('4) A stale approval cannot delete another note');
{
    clearAllNotes();
    // Add Note A and Note B. In reverse chronological order:
    // Note B is at index 0 (note #1)
    // Note A is at index 1 (note #2)
    const noteA = await addDistinctNote('Note Alpha', 'Alpha secret');
    const noteB = await addDistinctNote('Note Beta', 'Beta disposable');

    promptCount = 0;
    autoMode = 'approve';

    // Step 1: User approves deleting note #1 (which is Note Beta)
    const r1 = await skillManager.executeByName('notes', 'delete note 1');
    check('initial delete note 1 approved and executed', r1.success === true);
    check('Note Beta was deleted', memory.getNote(noteB.id) === undefined);
    check('Note Alpha still exists', memory.getNote(noteA.id) !== undefined);
    check('initial deletion prompted once', promptCount === 1);

    // Now Note Alpha has moved to index 0 (it is now note #1)!
    check('Note Alpha is now note #1', memory.getNotes()[0]?.id === noteA.id);

    // Step 2: Attempt to delete note 1 again, but user denies!
    // A stale approval must NOT allow Note Alpha to be deleted!
    promptCount = 0;
    autoMode = 'deny';
    const r2 = await skillManager.executeByName('notes', 'delete note 1');

    check('second delete note 1 was gated (not bypassed)', r2.success === false);
    check('stale approval did NOT delete Note Alpha', memory.getNote(noteA.id) !== undefined);
    check('second call prompted for confirmation instead of reusing stale memo', promptCount === 1);

    // Step 3: Stale keyword approval cannot delete a new note with the same keyword
    clearAllNotes();
    const temp1 = await addDistinctNote('Meeting Notes', 'Monday discussion');
    promptCount = 0;
    autoMode = 'approve';
    const rKw1 = await skillManager.executeByName('notes', 'delete note about Meeting');
    check('first Meeting note deleted', rKw1.success === true && memory.getNote(temp1.id) === undefined);

    // Now add a new note that matches "Meeting"
    const temp2 = await addDistinctNote('Meeting Notes', 'Tuesday discussion');
    promptCount = 0;
    autoMode = 'deny';
    const rKw2 = await skillManager.executeByName('notes', 'delete note about Meeting');
    check('second Meeting deletion was gated and denied', rKw2.success === false);
    check('stale keyword approval did NOT delete new meeting note', memory.getNote(temp2.id) !== undefined);
    check('second keyword deletion prompted for confirmation', promptCount === 1);

    // Step 4: A newer confirmation request supersedes/invalidates an existing approval
    clearAllNotes();
    const noteX = await addDistinctNote('Note X', 'content X');
    const noteY = await addDistinctNote('Note Y', 'content Y');
    // Note Y is #1, Note X is #2
    promptCount = 0;
    autoMode = 'approve';

    // Request confirmation for Note Y
    const p1 = permissions.requestConfirmation({ title: 'Prompt 1', message: 'Action 1', action: 'delete note 1' });
    const p1Meta = permissions.getPendingMeta();
    permissions.answer(true, p1Meta.id);
    await p1;

    // A newer confirmation request opens
    const p2 = permissions.requestConfirmation({ title: 'Prompt 2', message: 'Action 2', action: 'delete note 2' });
    const p2Meta = permissions.getPendingMeta();

    // The approval bound to prompt 1 cannot be reused when prompt 2 has been issued
    check('permissions recognizes newer prompt has incremented counter', permissions.getPendingMeta()?.id === p2Meta.id);
    permissions.answer(false, p2Meta.id);
    await p2;
}

console.log('5) Target snapshot & change detection while confirmation is pending');
{
    clearAllNotes();
    const note = await addDistinctNote('Original Title', 'Original content to delete');

    // 5a) Direct execution: note modified while confirmation is pending
    promptCount = 0;
    autoMode = null; // manual confirmation
    const pendingDelete = notes.execute('delete note 1');
    await new Promise((r) => setTimeout(r, 10)); // let prompt open
    check('confirmation prompt opened for deletion', permissions.hasPending() === true);
    const promptMeta = permissions.getPendingMeta();

    // Update the same note ID while confirmation is pending
    await new Promise((r) => setTimeout(r, 2));
    memory.updateNote(note.id, 'Updated Title', 'Modified content after prompt opened');
    check('note was updated while confirmation was pending', memory.getNote(note.id).title === 'Updated Title');

    // Approve the old prompt
    const approved = permissions.answer(true, promptMeta.id);
    check('old prompt was approved', approved === true);

    // Verify deletion was aborted
    const res = await pendingDelete;
    check('deletion of modified note was aborted', res.success === false);
    check('error explains that note changed and needs to be reviewed again',
        /changed.*review/i.test(res.error));
    check('updated note remains intact in memory', memory.getNote(note.id) !== undefined);
    check('updated note title preserved', memory.getNote(note.id).title === 'Updated Title');
    check('updated note content preserved', memory.getNote(note.id).content === 'Modified content after prompt opened');

    // 5b) Gateway execution: note modified while confirmation is pending in executeByName
    clearAllNotes();
    const noteGw = await addDistinctNote('Gateway Original', 'Gateway content');
    promptCount = 0;
    autoMode = null; // manual confirmation
    const pendingGwDelete = skillManager.executeByName('notes', 'delete note 1');
    await new Promise((r) => setTimeout(r, 10)); // let prompt open
    check('gateway confirmation prompt opened', permissions.hasPending() === true);
    const promptGwMeta = permissions.getPendingMeta();

    // Update the note while confirmation is pending
    await new Promise((r) => setTimeout(r, 2));
    memory.updateNote(noteGw.id, 'Gateway Updated', 'Updated content');

    // Approve the old prompt
    permissions.answer(true, promptGwMeta.id);
    const resGw = await pendingGwDelete;
    check('gateway deletion of modified note was aborted', resGw.success === false);
    check('error explains that note changed and needs review', /changed.*review/i.test(resGw.error));
    check('updated gateway note remains intact', memory.getNote(noteGw.id) !== undefined);
    check('updated gateway note title preserved', memory.getNote(noteGw.id).title === 'Gateway Updated');

    // 5c) Note disappeared while confirmation was pending
    clearAllNotes();
    const ephemNote = await addDistinctNote('Ephemeral Note', 'will disappear before delete');
    promptCount = 0;
    autoMode = null;
    const pendingEphem = notes.execute('delete note 1');
    await new Promise((r) => setTimeout(r, 10));
    const ephemMeta = permissions.getPendingMeta();

    // Manually delete the note while confirmation is pending
    memory.deleteNote(ephemNote.id);

    // Approve the old prompt
    permissions.answer(true, ephemMeta.id);
    const resEphem = await pendingEphem;
    check('deletion of disappeared note handled safely', resEphem.success === false);
    check('error indicates note disappeared/not found', /disappeared|couldn't find|no note found/i.test(resEphem.error));
}

console.log('6) Existing note creation, searching, listing, and valid deletion behavior remain intact');
{
    clearAllNotes();

    // Note creation via plain command
    const resCreate = await notes.execute('take a note buy sourdough bread and butter');
    check('take a note succeeds', resCreate.success === true);
    check('created note stored in memory', memory.getNotes().length === 1);
    check('created note content matches', memory.getNotes()[0].content.includes('sourdough bread'));

    // Note creation via agent path
    const resAgentCreate = await notes.execute('', { action: 'create', content: 'Agent research document' });
    check('agent create path succeeds', resAgentCreate.success === true);
    check('second note in memory', memory.getNotes().length === 2);

    // Note listing
    const resShow = await notes.execute('show my notes');
    check('show notes succeeds', resShow.success === true);
    check('show notes lists count', resShow.result.includes('2 notes'));

    // Note searching
    const resSearch = await notes.execute('search my notes for sourdough');
    check('search notes succeeds', resSearch.success === true);
    check('search notes returns matching note', resSearch.notes.length === 1 && resSearch.notes[0].content.includes('sourdough'));

    // Valid deletion by supported note number
    promptCount = 0;
    autoMode = 'approve';
    const resDel1 = await skillManager.executeByName('notes', 'delete note 1');
    check('valid deletion by note number succeeds', resDel1.success === true);
    check('one note remaining after note number deletion', memory.getNotes().length === 1);

    // Valid deletion by unambiguous keyword
    promptCount = 0;
    autoMode = 'approve';
    const resDelKw = await skillManager.executeByName('notes', 'delete note about sourdough');
    check('valid deletion by unambiguous keyword succeeds', resDelKw.success === true);
    check('zero notes remaining after keyword deletion', memory.getNotes().length === 0);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
