import test from 'node:test';
import assert from 'node:assert/strict';

import { generateScratchPadResponse, isChatActive } from '../src/generation.js';
import { createThread, updateThreadContextSettings, addMessage, getThread } from '../src/storage.js';

function setupHarness(overrides = {}) {
    const calls = [];
    const context = {
        extensionSettings: {},
        chatMetadata: {},
        chat: [],
        characters: [],
        characterId: 0,
        groupId: undefined,
        saveMetadata: async () => {},
        saveSettingsDebounced: () => {},
        setExtensionPrompt: (...args) => calls.push(args),
        generateQuietPrompt: async () => 'Assistant response',
        ...overrides,
    };

    context.extensionSettings.scratchPad = {
        ...(context.extensionSettings.scratchPad || {}),
        useStandardGeneration: true,
        oocSystemPrompt: 'OOC PROMPT',
        chatHistoryLimit: 0,
    };

    globalThis.SillyTavern = {
        getContext: () => context,
    };

    // Avoid ReferenceError in token usage best-effort logging.
    globalThis.window = {};

    return { context, calls };
}

async function runStandardGeneration({ contextOverrides = {}, threadSettings = {}, seedMessages = [] } = {}) {
    const { calls } = setupHarness(contextOverrides);

    const thread = createThread('Test Thread');
    assert.ok(thread, 'thread should be created');

    if (Object.keys(threadSettings).length > 0) {
        updateThreadContextSettings(thread.id, threadSettings);
    }

    for (const msg of seedMessages) {
        addMessage(thread.id, msg.role, msg.content, 'complete', 0);
    }

    const result = await generateScratchPadResponse('New question', thread.id);
    assert.equal(result.success, true, 'generation should succeed in test harness');
    assert.ok(result.gen_started, 'generation result should include start time');
    assert.ok(result.gen_finished, 'generation result should include finish time');

    const injectedCall = calls.find(args => args[0] === 'sp_quiet_inject' && typeof args[1] === 'string' && args[1].length > 0);
    assert.ok(injectedCall, 'should inject quiet prompt');

    return injectedCall[1];
}

test('isChatActive allows empty chats for active character/group', () => {
    setupHarness({ chat: [], characterId: 1, groupId: undefined });
    assert.equal(isChatActive(), true);

    setupHarness({ chat: [], characterId: undefined, groupId: 'group-1' });
    assert.equal(isChatActive(), true);

    setupHarness({ chat: [], characterId: undefined, groupId: undefined });
    assert.equal(isChatActive(), false);
});

test('standard generation builds quiet prompt with OOC prompt and thread history only', async () => {
    const quietPrompt = await runStandardGeneration({
        seedMessages: [
            { role: 'user', content: 'Older thread question' },
            { role: 'assistant', content: 'Older thread answer' },
        ],
    });

    // Should include OOC prompt, thread history, and user question
    assert.match(quietPrompt, /OOC PROMPT/);
    assert.match(quietPrompt, /--- PREVIOUS SCRATCH PAD DISCUSSION ---/);
    assert.match(quietPrompt, /--- USER QUESTION ---/);

    // Should NOT include context that ST's generateQuietPrompt already provides
    assert.doesNotMatch(quietPrompt, /--- SYSTEM PROMPT ---/);
    assert.doesNotMatch(quietPrompt, /--- CHARACTER INFORMATION ---/);
    assert.doesNotMatch(quietPrompt, /--- ROLEPLAY CHAT HISTORY ---/);
    assert.doesNotMatch(quietPrompt, /--- AUTHOR'S NOTE ---/);
});

test('standard generation stores response timing on assistant messages', async () => {
    setupHarness();

    const thread = createThread('Timing Thread');
    assert.ok(thread, 'thread should be created');

    const result = await generateScratchPadResponse('Timed question', thread.id);
    assert.equal(result.success, true);

    const updatedThread = getThread(thread.id);
    const assistantMessage = updatedThread.messages.find(msg => msg.role === 'assistant');

    assert.ok(assistantMessage.gen_started);
    assert.ok(assistantMessage.gen_finished);
    assert.ok(Date.parse(assistantMessage.gen_started) <= Date.parse(assistantMessage.gen_finished));
});
