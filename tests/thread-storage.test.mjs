import test from 'node:test';
import assert from 'node:assert/strict';

import {
    addImportedThreads,
    addMessage,
    createThread,
    deleteThread,
    forkThread,
    generateId,
    getMessageIdsToDelete,
    getThread,
    getThreadActivityTime,
    getThreads,
    removeMessages,
    restoreMessages,
    restoreThread,
    setThreadPinned,
    sortThreadsForDisplay,
    updateThread,
    updateThreadContextSettings,
} from '../src/storage.js';
import { exportFileName, parseThreadImport, threadToMarkdown, threadsToJson } from '../src/threadExport.js';

function setup() {
    const context = { chatMetadata: {}, chat: [{}, {}, {}], extensionSettings: {} };
    globalThis.SillyTavern = { getContext: () => context, libs: {} };
    return context;
}

function thread(id, { createdAt = '2026-01-01T00:00:00.000Z', messages = [], pinned = false } = {}) {
    return { id, name: id, createdAt, updatedAt: createdAt, messages, pinned };
}

test('threads sort by latest message activity, not by renames or settings changes', () => {
    const a = thread('a', { messages: [{ timestamp: '2026-03-01T00:00:00.000Z' }] });
    const b = thread('b', { messages: [{ timestamp: '2026-02-01T00:00:00.000Z', swipeTimestamps: ['2026-02-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'] }] });
    const c = thread('c', { createdAt: '2026-01-15T00:00:00.000Z' });
    a.updatedAt = '2026-12-01T00:00:00.000Z'; // renamed recently, no new messages

    assert.deepEqual(sortThreadsForDisplay([a, b, c]).map(t => t.id), ['b', 'a', 'c']);
    assert.equal(getThreadActivityTime(b), Date.parse('2026-04-01T00:00:00.000Z'));
});

test('edits count as activity', () => {
    const a = thread('a', { messages: [{ timestamp: '2026-01-02T00:00:00.000Z', editedAt: '2026-05-01T00:00:00.000Z' }] });
    const b = thread('b', { messages: [{ timestamp: '2026-03-01T00:00:00.000Z' }] });
    assert.deepEqual(sortThreadsForDisplay([b, a]).map(t => t.id), ['a', 'b']);
});

test('pinned threads stay on top', () => {
    const old = thread('old', { pinned: true });
    const recent = thread('recent', { messages: [{ timestamp: '2026-06-01T00:00:00.000Z' }] });
    assert.deepEqual(sortThreadsForDisplay([recent, old]).map(t => t.id), ['old', 'recent']);
});

test('pinning does not count as activity and unpinning removes the flag', () => {
    setup();
    const t = createThread('Pin me');
    const before = t.updatedAt;
    setThreadPinned(t.id, true);
    assert.equal(getThread(t.id).pinned, true);
    assert.equal(getThread(t.id).updatedAt, before);
    setThreadPinned(t.id, false);
    assert.equal('pinned' in getThread(t.id), false);
});

test('branching copies messages up to the chosen one with new ids', () => {
    setup();
    const source = createThread('Plot');
    updateThreadContextSettings(source.id, { includeWorldInfo: true });
    const q1 = addMessage(source.id, 'user', 'Q1');
    const a1 = addMessage(source.id, 'assistant', 'A1');
    addMessage(source.id, 'user', 'Q2');
    addMessage(source.id, 'assistant', 'A2');

    const fork = forkThread(source.id, a1.id);
    assert.equal(fork.name, 'Plot (branch)');
    assert.deepEqual(fork.messages.map(m => m.content), ['Q1', 'A1']);
    assert.notEqual(fork.messages[0].id, q1.id);
    assert.equal(fork.messages[0].chatMessageIndex, q1.chatMessageIndex);
    assert.equal(fork.contextSettings.includeWorldInfo, true);
    assert.equal(fork.titled, true);
    assert.equal(getThreads()[0].id, fork.id);

    // The copy is independent of the source
    fork.messages[0].content = 'changed';
    assert.equal(getThread(source.id).messages[0].content, 'Q1');
    assert.equal(getThread(source.id).messages.length, 4);
});

test('deleting a question also deletes its reply; deleting a reply removes only it', () => {
    setup();
    const t = createThread('T');
    const q1 = addMessage(t.id, 'user', 'Q1');
    const a1 = addMessage(t.id, 'assistant', 'A1');
    const q2 = addMessage(t.id, 'user', 'Q2');

    assert.deepEqual(getMessageIdsToDelete(getThread(t.id), q1.id), [q1.id, a1.id]);
    assert.deepEqual(getMessageIdsToDelete(getThread(t.id), a1.id), [a1.id]);
    assert.deepEqual(getMessageIdsToDelete(getThread(t.id), q2.id), [q2.id], 'unanswered question');
    assert.deepEqual(getMessageIdsToDelete(getThread(t.id), 'missing'), []);
});

test('removed messages can be put back in their original places', () => {
    setup();
    const t = createThread('T');
    const ids = ['Q1', 'A1', 'Q2', 'A2', 'Q3'].map((content, i) => addMessage(t.id, i % 2 ? 'assistant' : 'user', content).id);

    const removed = removeMessages(t.id, [ids[2], ids[3]]);
    assert.deepEqual(getThread(t.id).messages.map(m => m.content), ['Q1', 'A1', 'Q3']);

    assert.equal(restoreMessages(t.id, removed), true);
    assert.deepEqual(getThread(t.id).messages.map(m => m.content), ['Q1', 'A1', 'Q2', 'A2', 'Q3']);

    // Restoring twice doesn't duplicate
    restoreMessages(t.id, removed);
    assert.equal(getThread(t.id).messages.length, 5);
});

test('a deleted thread can be restored to its position', () => {
    setup();
    const first = createThread('first');
    const second = createThread('second');
    const third = createThread('third');
    const index = getThreads().indexOf(second);
    const removed = getThread(second.id);

    deleteThread(second.id);
    assert.deepEqual(getThreads().map(t => t.name), ['third', 'first']);
    assert.equal(restoreThread(removed, index), true);
    assert.deepEqual(getThreads().map(t => t.name), ['third', 'second', 'first']);
    assert.equal(restoreThread(removed, index), false, 'already restored');
    assert.ok(first && third);
});

test('markdown export uses the selected swipe and skips failed or pending replies', () => {
    const md = threadToMarkdown({
        name: 'Motives',
        messages: [
            { role: 'user', content: 'Why did she leave?' },
            { role: 'assistant', content: 'Because of the letter.', swipes: ['Other', 'Because of the letter.'], swipeId: 1 },
            { role: 'user', content: 'And then?' },
            { role: 'assistant', content: '', status: 'failed' },
            { role: 'assistant', content: 'partial', status: 'pending' },
        ],
    }, { userLabel: 'Aria' });

    assert.equal(md, '# Motives\n\n**Aria:**\n\nWhy did she leave?\n\n**Assistant:**\n\nBecause of the letter.\n\n**Aria:**\n\nAnd then?\n');
});

test('JSON export imports back with new ids, unlinked from the old chat', () => {
    setup();
    const t = createThread('Exported');
    updateThreadContextSettings(t.id, { includeSummary: true, connectionProfileId: 'profile-from-other-install' });
    addMessage(t.id, 'user', 'Q', 'complete', 5);
    addMessage(t.id, 'assistant', 'A', 'complete', 5);
    addMessage(t.id, 'assistant', '', 'pending', 5);
    setThreadPinned(t.id, true);

    const json = threadsToJson([getThread(t.id)], new Date('2026-10-12T00:00:00.000Z'));
    const parsed = JSON.parse(json);
    assert.equal(parsed.format, 'sillytavern-scratchpad-threads');
    assert.equal(parsed.exportedAt, '2026-10-12T00:00:00.000Z');

    const [imported] = parseThreadImport(json, generateId);
    assert.notEqual(imported.id, t.id);
    assert.equal(imported.name, 'Exported');
    assert.deepEqual(imported.messages.map(m => m.content), ['Q', 'A']);
    assert.ok(imported.messages.every(m => m.chatMessageIndex === null));
    assert.ok(imported.messages.every(m => !getThread(t.id).messages.some(o => o.id === m.id)));
    assert.equal(imported.contextSettings.includeSummary, true);
    assert.equal(imported.contextSettings.connectionProfileId, null);
    assert.equal(imported.pinned, undefined);

    assert.equal(addImportedThreads([imported]), 1);
    assert.equal(getThreads()[0].id, imported.id);
});

test('import rejects files that are not Scratch Pad exports', () => {
    assert.throws(() => parseThreadImport('not json', generateId), /not valid JSON/);
    assert.throws(() => parseThreadImport('{"format":"something-else","threads":[]}', generateId), /not a Scratch Pad/);
    assert.throws(() => parseThreadImport('{"threads":[]}', generateId), /No threads/);
    assert.throws(() => parseThreadImport('[]', generateId), /No threads/);
});

test('a bare thread object can be imported too', () => {
    const [imported] = parseThreadImport(JSON.stringify({ name: 'Bare', messages: [{ role: 'user', content: 'hi' }] }), generateId);
    assert.equal(imported.name, 'Bare');
    assert.equal(imported.messages.length, 1);
});

test('export file names are safe', () => {
    assert.equal(exportFileName('Why did she leave? / Part 2', 'md'), 'scratchpad-why-did-she-leave-part-2.md');
    assert.equal(exportFileName('???', 'json'), 'scratchpad-thread.json');
});

test('renaming does not move a thread in the list', () => {
    setup();
    const a = createThread('a');
    addMessage(a.id, 'user', 'old message');
    a.messages[0].timestamp = '2026-01-01T00:00:00.000Z';
    const b = createThread('b');
    addMessage(b.id, 'user', 'newer');
    b.messages[0].timestamp = '2026-02-01T00:00:00.000Z';

    updateThread(a.id, { name: 'renamed' });
    assert.deepEqual(sortThreadsForDisplay(getThreads()).map(t => t.name), ['b', 'renamed']);
});
