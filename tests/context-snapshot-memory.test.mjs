import test from 'node:test';
import assert from 'node:assert/strict';
import { createThread, deleteThread, clearAllThreads, restoreThread, removeMessages, restoreMessages, deleteSwipe, forkThread } from '../src/storage.js';
import { threadsToJson } from '../src/threadExport.js';
import { cloneWithSharedText } from '../src/immutableTextClone.js';

function setup() {
    const context = { chatMetadata: {}, chat: [], characterId: 0, getCurrentChatId: () => 'chat-a', extensionSettings: {}, saveSettingsDebounced() {} };
    globalThis.SillyTavern = { getContext: () => context };
    const first = createThread('first'), second = createThread('second');
    const data = context.chatMetadata.scratchPad;
    data.contextSnapshots = { shared: { version: 1 }, unique: { version: 1 }, second: { version: 1 } };
    first.messages = [{ id: 'a', role: 'assistant', content: 'A', extra: { contextSnapshotKey: 'unique' }, swipeExtra: [{ contextSnapshotKey: 'shared' }] }];
    second.messages = [{ id: 'b', role: 'assistant', content: 'B', extra: { contextSnapshotKey: 'second' }, swipeExtra: [{ contextSnapshotKey: 'shared' }] }];
    return { context, data, first, second };
}

test('deleting a thread prunes only unused snapshots and Undo restores the exact manifests', () => {
    const { data, first } = setup();
    const original = data.contextSnapshots.unique;
    deleteThread(first.id);
    assert.deepEqual(Object.keys(data.contextSnapshots).sort(), ['second', 'shared']);
    assert.ok(restoreThread(first, 0));
    assert.equal(data.contextSnapshots.unique, original);
    assert.deepEqual(Object.keys(data.contextSnapshots).sort(), ['second', 'shared', 'unique']);
});

test('message deletion prunes immediately, Undo restores snapshots, and clear leaves no pool', () => {
    const { data, first } = setup();
    const removed = removeMessages(first.id, ['a']);
    assert.equal(data.contextSnapshots.unique, undefined);
    restoreMessages(first.id, removed);
    assert.ok(data.contextSnapshots.unique);
    clearAllThreads();
    assert.equal(data.threads.length, 0);
    assert.equal(data.contextSnapshots, undefined);
});

test('deleting an inactive swipe releases its manifest without losing the selected one', () => {
    const { data, first } = setup();
    first.messages[0] = { id: 'a', role: 'assistant', content: 'active', swipeId: 1,
        swipes: ['alternate', 'active'], extra: { contextSnapshotKey: 'shared' },
        swipeExtra: [{ contextSnapshotKey: 'unique' }, { contextSnapshotKey: 'shared' }] };
    deleteSwipe(first.id, 'a', 0);
    assert.equal(data.contextSnapshots.unique, undefined);
    assert.ok(data.contextSnapshots.shared);
    assert.equal(first.messages[0].content, 'active');
});

test('branching preserves export history while all mutable structures stay independent', () => {
    const { first } = setup();
    const text = 'long immutable reply '.repeat(5000);
    first.messages[0].content = text;
    first.messages[0].swipes = [text, 'alternative'];
    first.messages[0].extra.nested = { values: [1, 2] };
    const before = JSON.parse(threadsToJson([first])).threads[0];
    const branch = forkThread(first.id, 'a');
    assert.equal(branch.messages[0].content, text);
    assert.deepEqual(branch.messages[0].swipes, first.messages[0].swipes);
    assert.notEqual(branch.messages[0].swipes, first.messages[0].swipes);
    assert.notEqual(branch.messages[0].extra.nested, first.messages[0].extra.nested);
    branch.messages[0].swipes[1] = 'changed';
    branch.messages[0].extra.nested.values.push(3);
    assert.equal(first.messages[0].swipes[1], 'alternative');
    assert.deepEqual(first.messages[0].extra.nested.values, [1, 2]);
    assert.deepEqual(JSON.parse(threadsToJson([first])).threads[0], before);
});

test('branch clone preserves aliases and cycles when richer structured data is present', () => {
    const item = { text: 'shared immutable text' };
    const input = { item, map: new Map([['item', item]]) };
    item.parent = input;
    const copy = cloneWithSharedText(input);
    assert.notEqual(copy.item, item);
    assert.equal(copy.map.get('item'), copy.item);
    assert.equal(copy.item.parent, copy);
});
