import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/regex-engine.mjs';
import { addMessage, createThread, getThreadForCurrentBranch, getThreadsForCurrentBranch } from '../src/storage.js';
import { buildPromptPreview } from '../src/generation.js';
import { migrateBranchHistory } from '../src/branchHistory.js';
import { buildCorpus } from '../src/semanticSearch.js';
import { parseThreadImport, threadsToJson } from '../src/threadExport.js';

function setup() {
    const context = { chat: Array.from({ length: 10 }, (_, i) => ({ mes: `Scene ${i}`, is_user: false })),
        chatMetadata: {}, extensionSettings: {}, characters: [], characterId: 0, mainApi: 'openai', chatCompletionSettings: {},
        saveSettingsDebounced() {}, substituteParams: text => text, chatId: 'original', getCurrentChatId() { return this.chatId; } };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

test('divergent branch history stays excluded from display and prompt after regrowth and reload', async () => {
    const context = setup();
    const thread = createThread('Timeline');
    addMessage(thread.id, 'user', 'What happened?', 'complete', 4);
    addMessage(thread.id, 'assistant', 'SHARED_PAST', 'complete', 4);
    addMessage(thread.id, 'user', 'What happens in the future?');
    addMessage(thread.id, 'assistant', 'OLD_FUTURE_SECRET');
    context.chatMetadata = structuredClone(context.chatMetadata);
    context.chat = structuredClone(context.chat.slice(0, 4));
    context.chatId = 'new-branch';
    for (const grow of [false, true]) {
        if (grow) context.chat.push(...Array.from({ length: 8 }, () => ({ mes: 'Different future', is_user: true })));
        const view = getThreadForCurrentBranch(thread.id);
        assert.equal(view.messages.length, 2);
        assert.equal(view.branchedMessages.length, 2);
        assert.equal(getThreadsForCurrentBranch()[0].messages.length, 2);
        const before = JSON.stringify([context.chat, context.chatMetadata]);
        const preview = await buildPromptPreview(thread.id, 'What do we know?');
        assert.match(JSON.stringify(preview.messages), /SHARED_PAST/);
        assert.doesNotMatch(JSON.stringify(preview.messages), /OLD_FUTURE_SECRET/);
        assert.equal(JSON.stringify([context.chat, context.chatMetadata]), before, 'preview does not modify saved history');
        assert.equal(buildCorpus().entries.find(entry => entry.text === 'OLD_FUTURE_SECRET').branchLabel, 'Other branch');
    }
});

test('legacy future positions stay unresolved after growth; portable imports stay visible', () => {
    const context = setup();
    const thread = createThread('Legacy');
    thread.messages = [{ id: 'legacy', role: 'assistant', content: 'Future', chatMessageIndex: 10 }];
    context.chat = context.chat.slice(0, 4);
    assert.equal(migrateBranchHistory(), true);
    context.chat.push(...Array.from({ length: 12 }, () => ({ mes: 'New' })));
    assert.equal(getThreadForCurrentBranch(thread.id).messages.length, 0);
    const imported = parseThreadImport(threadsToJson([thread]), () => 'imported');
    context.chatMetadata.scratchPad.threads = imported;
    assert.equal(getThreadForCurrentBranch('imported').messages.length, 1);
    assert.equal(imported[0].messages[0].branchAnchor, null);
});

test('anchors survive insertion and distinguish a branch from an alternative swipe', () => {
    const context = setup();
    context.chat.at(-1).swipe_id = 1;
    const thread = createThread('Swipes');
    addMessage(thread.id, 'assistant', 'Original swipe context');
    context.chat.unshift({ mes: 'Inserted' });
    assert.equal(getThreadForCurrentBranch(thread.id).messages.length, 1);
    context.chat.at(-1).swipe_id = 0;
    assert.equal(getThreadForCurrentBranch(thread.id).messages.length, 1, 'same-chat edits remain available for comparison');
    context.chatId = 'other-swipe-branch';
    assert.equal(getThreadForCurrentBranch(thread.id).messages.length, 0);
});
