import test from 'node:test';
import assert from 'node:assert/strict';
import { regexMock } from './helpers/regex-engine.mjs';
import { buildPromptPreview, cancelGeneration, generateScratchPadResponse, generateSwipe, retryMessage, editUserMessageAndRegenerate, generateRawPromptResponse } from '../src/generation.js';
import { createThread, getThread, setActiveSwipe, forkThread, ensureSwipeFields, addMessage } from '../src/storage.js';

const message = (mes, is_user = false) => ({ name: is_user ? 'Mira' : 'Narrator', mes, is_user });
function setup(settings = {}, overrides = {}) {
    regexMock.reset();
    const calls = [];
    const context = {
        chatId: 'chat-a',
        getCurrentChatId() { return this.chatId; },
        chatMetadata: {},
        chat: [message('Mira holds the brass key.', true), message('The gate is closed.')],
        extensionSettings: { scratchPad: { useStandardGeneration: true, oocSystemPrompt: 'Answer the question.', ...settings } },
        mainApi: 'openai', characterId: 0, name1: 'Mira', characters: [],
        chatCompletionSettings: { stream_openai: false },
        saveMetadata: async () => {}, saveSettingsDebounced() {},
        generateRaw: async args => { calls.push(args); return 'A concise answer.'; },
        sendGenerationRequest: async (type, args) => { calls.push(args); return { choices: [{ message: { content: 'A concise answer.' } }] }; },
        extractMessageFromData: data => data.choices[0].message.content,
        ...overrides,
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.window = {};
    const thread = createThread('Notes', { includeCharacterCard: false, includePersona: false });
    thread.titled = true;
    const text = payload => typeof payload.prompt === 'string' ? `${payload.systemPrompt || ''}\n${payload.prompt}` : (payload.prompt || []).map(m => m.content).join('\n');
    return {
        context, calls, thread,
        last: () => text(calls.at(-1)),
        async ask(question = 'What next?') {
            const result = await generateScratchPadResponse(question, thread.id);
            assert.equal(result.success, true, result.error);
            return result;
        },
        async preview(id = thread.id) {
            const preview = await buildPromptPreview(id, 'Next question?');
            return preview.messages.map(m => m.content).join('\n');
        },
        pool: () => context.chatMetadata.scratchPad.contextSnapshots || {},
    };
}
const notice = text => text.split('--- CHANGES SINCE YOUR PREVIOUS REPLY ---').at(-1).split('--- USER QUESTION ---')[0];

test('first use, preview immutability, successful persistence, reload, and deduplication', async () => {
    const h = setup();
    const before = JSON.stringify({ chat: h.context.chat, data: h.context.chatMetadata });
    assert.match(await h.preview(), /No previous main-chat context is recorded/);
    assert.equal(JSON.stringify({ chat: h.context.chat, data: h.context.chatMetadata }), before);
    await h.ask();
    assert.ok(h.context.chat.every(m => typeof m.scratchPadContextId === 'string'));
    assert.equal(Object.keys(h.pool()).length, 1);
    assert.doesNotMatch(JSON.stringify(h.pool()), /brass key|gate is closed/);
    h.context.chat = structuredClone(h.context.chat);
    h.context.chatMetadata = structuredClone(h.context.chatMetadata);
    assert.match(notice(await h.preview()), /Unchanged/);
    await h.ask();
    assert.equal(Object.keys(h.pool()).length, 1, 'identical manifests are shared across replies');
});

for (const standard of [true, false]) for (const multi of [true, false]) {
    test(`numbered current text and change notices reach generation (standard=${standard}, multi=${multi})`, async () => {
        const h = setup({ useStandardGeneration: standard, useMultiMessageFormat: multi });
        await h.ask();
        h.context.chat[1].mes = 'The gate is open.';
        h.context.chat.push(message('A bell rings.'));
        await h.ask();
        const text = h.last();
        assert.match(text, /\[Message #1 \| Narrator\]\nThe gate is open/);
        assert.match(notice(text), /Changed: Message #1/);
        assert.match(notice(text), /New: Message #2/);
        assert.match(text, /Current main-chat text is authoritative/);
        assert.match(text, /Earlier Scratch Pad replies may describe older text/);
        assert.doesNotMatch(text, /gate is closed|scratchPadContextId|contextSnapshotKey|[a-f0-9]{64}/);
        assert.equal((text.match(/The gate is open/g) || []).length, 1);
        assert.match(notice(await h.preview()), /Unchanged/);
    });
}

test('selected main-chat swipes count as changed, including equal text under a new selection', async () => {
    const h = setup();
    h.context.chat[1].swipes = ['The gate is closed.', 'The gate is open.'];
    h.context.chat[1].swipe_id = 0;
    await h.ask();
    h.context.chat[1].swipe_id = 1;
    h.context.chat[1].mes = 'The gate is open.';
    assert.match(notice(await h.preview()), /Changed: Message #1/);
    await h.ask();
    h.context.chat[1].swipe_id = 2;
    assert.match(notice(await h.preview()), /Changed: Message #1/);
});

test('deletion preserves survivor identity and reports old removal numbers without cascade edits', async () => {
    const h = setup();
    await h.ask();
    h.context.chat.splice(0, 1);
    const text = await h.preview();
    assert.match(text, /\[Message #0 \| Narrator\]\nThe gate is closed/);
    assert.match(notice(text), /Removed: Message #0 \(deleted; previous numbers\)/);
    assert.match(notice(text), /Message numbers shifted/);
    assert.doesNotMatch(notice(text), /Changed:|New:/);
    assert.doesNotMatch(text, /Mira holds the brass key/);
});

test('insertion renumbers existing messages without claiming they were edited', async () => {
    const h = setup();
    await h.ask();
    h.context.chat.unshift(message('Earlier that evening.'));
    const changes = notice(await h.preview());
    assert.match(changes, /New: Message #0/);
    assert.match(changes, /Message numbers shifted/);
    assert.doesNotMatch(changes, /Changed:|Removed:/);
});

test('ranges, limits, hidden messages, and later inclusion are not story additions or deletions', async () => {
    const h = setup();
    await h.ask();
    h.thread.contextSettings.chatHistoryRangeMode = 'start_to';
    h.thread.contextSettings.chatHistoryRangeEnd = 1;
    assert.match(notice(await h.preview()), /Not included now: Message #1 \(still in the chat/);
    await h.ask();
    h.thread.contextSettings.chatHistoryRangeMode = 'all';
    assert.match(notice(await h.preview()), /Included now: Message #1 \(already existed/);
    await h.ask();
    h.context.chat[0].is_system = true;
    let text = await h.preview();
    assert.match(text, /\[Message #1 \| Narrator\]/);
    assert.doesNotMatch(text, /\[Message #0/);
    assert.match(notice(text), /Not included now: Message #0/);
    assert.doesNotMatch(notice(text), /Removed:|New:/);
    await h.ask();
    h.thread.contextSettings.includeHiddenMessages = true;
    assert.match(notice(await h.preview()), /Included now: Message #0/);
});

test('previously unseen existing messages are included context, not newly added story', async () => {
    const h = setup({ chatHistoryLimit: 1 });
    await h.ask();
    h.context.extensionSettings.scratchPad.chatHistoryLimit = 0;
    const changes = notice(await h.preview());
    assert.match(changes, /Included now: Message #0/);
    assert.doesNotMatch(changes, /New:/);
});

test('token trimming uses original numbers and records only the context actually sent', async () => {
    const h = setup({}, {
        getTokenCountAsync: async text => String(text).split(/\s+/).length,
        chatCompletionSettings: { stream_openai: false, openai_max_context: 130, openai_max_tokens: 0 },
    });
    h.context.chat[0].mes = 'OLD_CONTEXT '.repeat(200);
    await h.ask();
    assert.doesNotMatch(h.last(), /OLD_CONTEXT/);
    assert.match(h.last(), /\[Message #1 \| Narrator\]/);
    const snapshot = h.pool()[h.thread.messages.at(-1).extra.contextSnapshotKey];
    assert.deepEqual(snapshot.seen.map(entry => entry.number), [1]);
    h.context.chatCompletionSettings.openai_max_context = 1000;
    const changes = notice(await h.preview());
    assert.match(changes, /Included now: Message #0/);
    assert.doesNotMatch(changes, /New:|Removed:/);
});

test('regex changes are compared as sent text; stripped raw edits do not invent context changes', async () => {
    const h = setup();
    regexMock.process = text => text.replace(/<private>.*?<\/private>/g, '');
    h.context.chat[1].mes += '<private>OLD_PRIVATE</private>';
    await h.ask();
    h.context.chat[1].mes = 'The gate is closed.<private>NEW_PRIVATE</private>';
    const text = await h.preview();
    assert.match(notice(text), /Unchanged/);
    assert.doesNotMatch(text, /OLD_PRIVATE|NEW_PRIVATE/);
});

test('legacy, missing, unknown-scope, and different-chat contexts explicitly reset comparison', async () => {
    const h = setup();
    addMessage(h.thread.id, 'assistant', 'Legacy answer');
    assert.match(notice(await h.preview()), /Previous context unavailable for comparison/);
    await h.ask();
    const key = h.thread.messages.at(-1).extra.contextSnapshotKey;
    delete h.pool()[key];
    assert.match(notice(await h.preview()), /Previous context unavailable for comparison/);
    await h.ask();
    h.context.chatId = 'chat-branch';
    assert.match(notice(await h.preview()), /Previous context unavailable for comparison/);
    await h.ask();
    assert.match(notice(await h.preview()), /Unchanged/);
    h.context.getCurrentChatId = () => null;
    assert.match(notice(await h.preview()), /Previous context unavailable for comparison/);
});

test('lost/duplicated identities and ambiguous replacement reset instead of guessing', async () => {
    const h = setup();
    await h.ask();
    delete h.context.chat[0].scratchPadContextId;
    h.context.chat = structuredClone(h.context.chat);
    assert.match(notice(await h.preview()), /Previous context unavailable for comparison/);
    await h.ask();
    h.context.chat.push(structuredClone(h.context.chat[0]));
    assert.match(notice(await h.preview()), /Previous context unavailable for comparison/);
    await h.ask();
    assert.match(notice(await h.preview()), /Unchanged/);
    h.context.chat.splice(0, 1, message('A replacement with unknown identity.'));
    assert.match(notice(await h.preview()), /Previous context unavailable for comparison/);
});

test('alternate Scratch Pad swipes and forked threads follow their selected reply snapshots', async () => {
    const h = setup();
    await h.ask();
    const reply = h.thread.messages.at(-1);
    const originalKey = reply.extra.contextSnapshotKey;
    h.context.chat[1].mes = 'The gate is open.';
    assert.equal((await generateSwipe(h.thread.id, reply.id)).success, true);
    assert.match(notice(h.last()), /Changed: Message #1/);
    const newKey = reply.extra.contextSnapshotKey;
    assert.notEqual(newKey, originalKey);
    setActiveSwipe(h.thread.id, reply.id, 0);
    assert.equal(reply.extra.contextSnapshotKey, originalKey);
    assert.match(notice(await h.preview()), /Changed: Message #1/);
    setActiveSwipe(h.thread.id, reply.id, 1);
    assert.match(notice(await h.preview()), /Unchanged/);
    const fork = forkThread(h.thread.id, reply.id);
    assert.match(notice(await h.preview(fork.id)), /Unchanged/);
    // A legacy swipe never borrows the currently selected swipe's baseline.
    ensureSwipeFields(reply);
    delete reply.swipeExtra[0].contextSnapshotKey;
    setActiveSwipe(h.thread.id, reply.id, 0);
    assert.equal(reply.extra.contextSnapshotKey, undefined);
    assert.match(notice(await h.preview()), /Previous context unavailable/);
});

test('failed requests and retries do not advance the reference until success', async () => {
    const h = setup();
    await h.ask();
    const before = JSON.stringify(h.pool());
    h.context.chat[1].mes = 'The gate is open.';
    h.context.generateRaw = async () => { throw new Error('Fixture failure'); };
    const failed = await generateScratchPadResponse('Try now', h.thread.id);
    assert.equal(failed.success, false);
    assert.equal(JSON.stringify(h.pool()), before);
    assert.match(notice(await h.preview()), /Changed: Message #1/);
    h.context.generateRaw = async args => { h.calls.push(args); return 'Retry answer.'; };
    assert.equal((await retryMessage(h.thread.id, h.thread.messages.at(-1).id)).success, true);
    assert.match(notice(h.last()), /Changed: Message #1/);
    assert.match(notice(await h.preview()), /Unchanged/);
});

test('cancelled normal replies and failed/cancelled swipes keep the last successful baseline', async () => {
    const h = setup();
    await h.ask();
    const reply = h.thread.messages.at(-1);
    const key = reply.extra.contextSnapshotKey;
    const pool = JSON.stringify(h.pool());
    h.context.chat[1].mes = 'The gate is open.';
    h.context.generateRaw = async () => { cancelGeneration(); return 'Partial answer.'; };
    const cancelled = await generateScratchPadResponse('Cancel now', h.thread.id);
    assert.equal(cancelled.cancelled, true);
    assert.equal(JSON.stringify(h.pool()), pool);
    assert.match(notice(await h.preview()), /Changed: Message #1/);
    assert.equal((await generateSwipe(h.thread.id, reply.id)).cancelled, true);
    assert.equal(reply.extra.contextSnapshotKey, key);
    h.context.generateRaw = async () => { throw new Error('Swipe fixture failure'); };
    assert.equal((await generateSwipe(h.thread.id, reply.id)).success, false);
    assert.equal(reply.extra.contextSnapshotKey, key);
    assert.equal(JSON.stringify(h.pool()), pool);
});

test('an in-flight completion cannot advance comparison in another chat with copied thread IDs', async () => {
    let release;
    let started;
    const running = new Promise(resolve => { started = resolve; });
    const h = setup({}, { generateRaw: async () => { started(); return new Promise(resolve => { release = resolve; }); } });
    const originalMetadata = h.context.chatMetadata;
    const request = generateScratchPadResponse('Question', h.thread.id);
    await running;
    h.context.chatId = 'copied-branch';
    h.context.chatMetadata = structuredClone(h.context.chatMetadata);
    release('Wrong-chat answer');
    assert.equal((await request).success, false);
    assert.equal(Object.keys(h.pool()).length, 0);
    assert.equal(originalMetadata.scratchPad.contextSnapshots, undefined);
    assert.doesNotMatch(JSON.stringify(h.context.chatMetadata), /Wrong-chat answer/);
});

test('swipe comparisons include selected text once, in numbered chronological history', async () => {
    const h = setup();
    h.thread.contextSettings.swipeContextMode = 'assistant';
    h.thread.contextSettings.chatHistoryRangeMode = 'start_to';
    h.thread.contextSettings.chatHistoryRangeEnd = 1;
    h.context.chat[1].swipes = ['The gate is closed.', 'The gate is open.'];
    h.context.chat[1].swipe_id = 0;
    const text = await h.preview();
    assert.equal((text.match(/The gate is closed/g) || []).length, 1);
    assert.match(text, /Swipe 1 \(currently selected\): see Message #1/);
    assert.ok(text.indexOf('[Message #0') < text.indexOf('[Message #1'));
    assert.match(text, /Swipe 2:\nThe gate is open/);
});

test('editing an earlier Scratch Pad question uses the preceding reply, not the discarded later reply', async () => {
    const h = setup();
    await h.ask('First question');
    h.context.chat[1].mes = 'The gate is open.';
    await h.ask('Second question');
    const question = h.thread.messages.at(-2);
    h.context.chat[1].mes = 'The gate is closed.';
    assert.equal((await editUserMessageAndRegenerate(h.thread.id, question.id, 'Edited second question')).success, true);
    assert.match(notice(h.last()), /Unchanged/);
});

test('raw replies and empty replies do not replace a successful contextual reference', async () => {
    const h = setup();
    await h.ask();
    const before = JSON.stringify(h.pool());
    assert.equal((await generateRawPromptResponse('Raw fixture question', h.thread.id)).success, true);
    assert.equal(JSON.stringify(h.pool()), before);
    h.context.generateRaw = async () => '';
    await h.ask('Empty answer');
    assert.equal(JSON.stringify(h.pool()), before);
    assert.match(notice(await h.preview()), /Unchanged/);
});

test('card-only context is recorded as omitted chat rather than a deletion', async () => {
    const h = setup();
    await h.ask();
    h.thread.contextSettings.characterCardOnly = true;
    await h.ask();
    assert.match(notice(h.last()), /Not included now: Messages #0-#1/);
    assert.doesNotMatch(h.last(), /brass key|gate is closed/);
    h.thread.contextSettings.characterCardOnly = false;
    const changes = notice(await h.preview());
    assert.match(changes, /Included now: Messages #0-#1/);
    assert.doesNotMatch(changes, /New:/);
});

test('Connection Manager profile requests carry the same deterministic notice', async () => {
    const h = setup({ useAlternativeApi: true, connectionProfileId: 'fixture-profile' }, {
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
        },
    });
    h.context.extensionSettings.connectionManager = { profiles: [{ id: 'fixture-profile', api: 'openai', name: 'Fixture' }] };
    h.context.ConnectionManagerRequestService.sendRequest = async (profileId, messages) => {
        h.calls.push({ prompt: messages });
        return { content: 'Profile answer.' };
    };
    await h.ask();
    h.context.chat[1].mes = 'The gate is open.';
    await h.ask();
    assert.match(notice(h.last()), /Changed: Message #1/);
    assert.match(notice(await h.preview()), /Unchanged/);
});

test('resolved main-chat macros are fingerprinted as sent, and unresolved macros reset comparison', async () => {
    const h = setup();
    let state = 'closed';
    h.context.substituteParams = text => text.replaceAll('{{state}}', state);
    h.context.chat[1].mes = 'The gate is {{state}}.';
    await h.ask();
    assert.match(h.last(), /The gate is closed/);
    state = 'open';
    assert.match(notice(await h.preview()), /Changed: Message #1/);
    await h.ask();
    assert.match(h.last(), /The gate is open/);
    assert.match(notice(await h.preview()), /Unchanged/);
    h.context.chat[1].mes = 'Unknown {{unresolved}} text';
    await h.ask();
    assert.match(notice(await h.preview()), /Previous context unavailable/);
});

test('streaming requests use the same numbered context and commit only the completed reply', async () => {
    const h = setup({ useStandardGeneration: false }, {
        chatCompletionSettings: { stream_openai: true, chat_completion_source: 'custom', custom_url: 'http://fixture.invalid', custom_model: 'fixture' },
        getChatCompletionModel: () => 'fixture', getRequestHeaders: () => ({}),
    });
    const previousFetch = globalThis.fetch;
    const streamed = [];
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/generate');
        const request = JSON.parse(options.body);
        const text = request.messages.map(message => message.content).join('\n');
        assert.match(text, /\[Message #0 \| Mira\]/);
        assert.match(text, /CHANGES SINCE YOUR PREVIOUS REPLY/);
        return new Response('data: {"choices":[{"delta":{"content":"Streamed answer."}}]}\n\ndata: [DONE]\n\n');
    };
    try {
        const result = await generateScratchPadResponse('Streaming question', h.thread.id, text => streamed.push(text));
        assert.equal(result.success, true, result.error);
        assert.ok(streamed.some(text => text.includes('Streamed answer.')));
        assert.ok(h.thread.messages.at(-1).extra.contextSnapshotKey);
        assert.match(notice(await h.preview()), /Unchanged/);
    } finally { globalThis.fetch = previousFetch; }
});

test('switching chats during the initial save stops before any generation request', async () => {
    const h = setup();
    h.context.saveMetadata = async () => { h.context.chatId = 'different-chat'; };
    const result = await generateScratchPadResponse('Question', h.thread.id);
    assert.equal(result.success, false);
    assert.equal(h.calls.length, 0);
    assert.equal(Object.keys(h.pool()).length, 0);
});

test('malformed saved records are unavailable rather than crashing future prompts', async () => {
    const h = setup();
    await h.ask();
    const key = h.thread.messages.at(-1).extra.contextSnapshotKey;
    h.pool()[key].seen = [null];
    assert.match(notice(await h.preview()), /Previous context unavailable for comparison/);
    await h.ask();
    assert.match(notice(await h.preview()), /Unchanged/);
});
