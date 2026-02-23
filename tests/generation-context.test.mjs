import test from 'node:test';
import assert from 'node:assert/strict';

import { generateScratchPadResponse, isChatActive } from '../src/generation.js';
import { createThread, updateThreadContextSettings, addMessage } from '../src/storage.js';

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

test('standard generation includes system prompt from chatMetadata', async () => {
    const quietPrompt = await runStandardGeneration({
        contextOverrides: {
            chatMetadata: {
                note_prompt: 'Author note',
                system_prompt: 'System from chatMetadata',
            },
        },
        threadSettings: {
            includeSystemPrompt: true,
            includeAuthorsNote: true,
            includeCharacterCard: false,
            characterCardOnly: false,
        },
    });

    assert.match(quietPrompt, /--- SYSTEM PROMPT ---\n\nSystem from chatMetadata/);
});

test('standard generation falls back to chat_metadata system prompt', async () => {
    const quietPrompt = await runStandardGeneration({
        contextOverrides: {
            chatMetadata: {
                note_prompt: 'Author note',
            },
            chat_metadata: {
                system_prompt: 'System from chat_metadata',
            },
        },
        threadSettings: {
            includeSystemPrompt: true,
            includeAuthorsNote: true,
            includeCharacterCard: false,
            characterCardOnly: false,
        },
    });

    assert.match(quietPrompt, /--- SYSTEM PROMPT ---\n\nSystem from chat_metadata/);
});

test('standard generation honors characterCardOnly by excluding chat and thread history', async () => {
    const quietPrompt = await runStandardGeneration({
        contextOverrides: {
            chat: [
                { is_user: true, mes: 'chat-1' },
                { is_user: false, name: 'Char', mes: 'chat-2' },
            ],
            characters: [
                {
                    name: 'Aster',
                    description: 'Test character',
                },
            ],
            characterId: 0,
        },
        threadSettings: {
            includeCharacterCard: true,
            characterCardOnly: true,
            includeAuthorsNote: true,
        },
        seedMessages: [
            { role: 'user', content: 'Older thread question' },
            { role: 'assistant', content: 'Older thread answer' },
        ],
    });

    assert.match(quietPrompt, /--- CHARACTER INFORMATION ---/);
    assert.doesNotMatch(quietPrompt, /--- ROLEPLAY CHAT HISTORY ---/);
    assert.doesNotMatch(quietPrompt, /--- PREVIOUS SCRATCH PAD DISCUSSION ---/);
});

test('standard generation honors chat history range selection', async () => {
    const quietPrompt = await runStandardGeneration({
        contextOverrides: {
            chat: [
                { is_user: true, mes: 'm1' },
                { is_user: true, mes: 'm2' },
                { is_user: true, mes: 'm3' },
            ],
        },
        threadSettings: {
            includeCharacterCard: false,
            characterCardOnly: false,
            includeAuthorsNote: true,
            chatHistoryRangeMode: 'between',
            chatHistoryRangeStart: 2,
            chatHistoryRangeEnd: 2,
        },
    });

    assert.match(quietPrompt, /User: m2/);
    assert.doesNotMatch(quietPrompt, /User: m1/);
    assert.doesNotMatch(quietPrompt, /User: m3/);
});
