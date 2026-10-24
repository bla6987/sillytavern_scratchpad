import test from 'node:test';
import assert from 'node:assert/strict';
import { regexMock, regex_placement } from './helpers/regex-engine.mjs';

import { buildPromptPreview, generateScratchPadResponse, generateSwipe } from '../src/generation.js';
import { createThread, updateThreadContextSettings, getThread, ensureSwipeFields, setActiveSwipe } from '../src/storage.js';
import { getCurrentContextSettings } from '../src/settings.js';

function setupHarness(overrides = {}, scratchPadSettings = {}) {
    regexMock.reset();
    const calls = [];
    const context = {
        extensionSettings: {},
        chatMetadata: {},
        chat: [],
        characters: [{ name: 'Seraphina', avatar: 'sera.png', description: 'Forest guardian' }],
        characterId: 0,
        groupId: undefined,
        name1: 'Aria',
        powerUserSettings: { persona_description: 'A wandering bard.' },
        mainApi: 'openai',
        chatCompletionSettings: { stream_openai: false },
        saveMetadata: async () => {},
        saveSettingsDebounced: () => {},
        substituteParams: (text) => text,
        generateRaw: async (args) => {
            calls.push(args);
            return 'Assistant response';
        },
        ...overrides,
    };

    context.extensionSettings.scratchPad = {
        useStandardGeneration: true,
        oocSystemPrompt: 'OOC PROMPT',
        chatHistoryLimit: 0,
        ...scratchPadSettings,
    };

    globalThis.SillyTavern = { getContext: () => context };
    globalThis.window = {};
    return { context, calls };
}

async function ask(threadSettings = {}, question = 'Question?') {
    const thread = createThread('Test');
    if (Object.keys(threadSettings).length) {
        updateThreadContextSettings(thread.id, threadSettings);
    }
    const result = await generateScratchPadResponse(question, thread.id);
    assert.equal(result.success, true, result.error);
    return { thread: getThread(thread.id), result };
}

test('group chats send every member card', async () => {
    const { calls } = setupHarness({
        characters: [
            { name: 'Seraphina', avatar: 'sera.png', description: 'Forest guardian' },
            { name: 'Bob', avatar: 'bob.png', description: 'Merchant' },
        ],
        characterId: undefined,
        groupId: 'g1',
        groups: [{ id: 'g1', members: ['sera.png', 'bob.png'] }],
    });
    await ask();
    assert.match(calls[0].prompt, /--- CHARACTER INFORMATION ---/);
    assert.match(calls[0].prompt, /Character Name: Seraphina/);
    assert.match(calls[0].prompt, /Character Name: Bob/);
});

test('persona is sent by default and user messages use the persona name', async () => {
    const { calls } = setupHarness({
        chat: [{ is_user: true, mes: 'Hi there' }, { is_user: false, name: 'Seraphina', mes: 'Hello' }],
    });
    await ask();
    assert.match(calls[0].prompt, /--- USER PERSONA ---\n\nName: Aria\n\nDescription: A wandering bard\./);
    assert.match(calls[0].prompt, /\[Message #0 \| Aria\]\nHi there/);
    assert.doesNotMatch(calls[0].prompt, /User: Hi there/);
});

test('persona can be turned off per thread', async () => {
    const { calls } = setupHarness();
    await ask({ includePersona: false });
    assert.doesNotMatch(calls[0].prompt, /USER PERSONA/);
});

test('hidden messages are left out unless the thread includes them', async () => {
    const chat = [
        { is_user: true, name: 'Aria', mes: 'Visible one' },
        { is_user: false, name: 'Seraphina', mes: 'Hidden reply', is_system: true },
        { is_user: true, name: 'Aria', mes: 'Visible two' },
    ];

    let { calls } = setupHarness({ chat });
    await ask();
    assert.match(calls[0].prompt, /Visible one/);
    assert.doesNotMatch(calls[0].prompt, /Hidden reply/);

    ({ calls } = setupHarness({ chat }));
    await ask({ includeHiddenMessages: true });
    assert.match(calls[0].prompt, /Hidden reply/);
});

test('the history limit counts only messages that will be sent', async () => {
    const chat = [
        { is_user: true, name: 'Aria', mes: 'Oldest' },
        { is_user: false, name: 'Seraphina', mes: 'Middle' },
        { is_user: true, name: 'Aria', mes: 'Hidden newest', is_system: true },
    ];
    const { calls } = setupHarness({ chat }, { chatHistoryLimit: 2 });
    await ask();
    assert.match(calls[0].prompt, /Oldest/);
    assert.match(calls[0].prompt, /Middle/);
    assert.doesNotMatch(calls[0].prompt, /Hidden newest/);
});

test('world info and summary are sent when enabled, in that order', async () => {
    const { calls } = setupHarness({
        chat: [{ is_user: true, name: 'Aria', mes: 'Tell me', extra: { memory: 'They met in the forest.' } }],
        getWorldInfoPrompt: async () => ({ worldInfoBefore: 'The forest is enchanted.', worldInfoAfter: '' }),
    });
    await ask({ includeWorldInfo: true, includeSummary: true });
    const prompt = calls[0].prompt;
    assert.match(prompt, /--- WORLD INFO ---\n\nThe forest is enchanted\./);
    assert.match(prompt, /--- STORY SUMMARY ---\n\nThey met in the forest\./);
    assert.ok(prompt.indexOf('WORLD INFO') < prompt.indexOf('STORY SUMMARY'));
    assert.ok(prompt.indexOf('STORY SUMMARY') < prompt.indexOf('ROLEPLAY CHAT HISTORY'));
});

test('world info and summary are off by default', async () => {
    let scanned = false;
    const { calls } = setupHarness({
        chat: [{ is_user: true, name: 'Aria', mes: 'Tell me', extra: { memory: 'Summary text' } }],
        getWorldInfoPrompt: async () => { scanned = true; return { worldInfoBefore: 'Lore' }; },
    });
    await ask();
    assert.equal(scanned, false);
    assert.doesNotMatch(calls[0].prompt, /WORLD INFO|STORY SUMMARY/);
});

test('multi-message format labels the new context sections', async () => {
    const { calls } = setupHarness({
        chat: [{ is_user: true, name: 'Aria', mes: 'Tell me', extra: { memory: 'Summary text' } }],
        getWorldInfoPrompt: async () => ({ worldInfoBefore: 'Lore entry' }),
    }, { useMultiMessageFormat: true });
    await ask({ includeWorldInfo: true, includeSummary: true });
    const contents = calls[0].prompt.map(m => m.content);
    assert.ok(contents.includes('User persona:\n\nName: Aria\n\nDescription: A wandering bard.'));
    assert.ok(contents.includes('World Info:\n\nLore entry'));
    assert.ok(contents.includes('Story summary:\n\nSummary text'));
});

test('new threads copy the global defaults for the new context options', () => {
    setupHarness({}, { includePersona: false, includeWorldInfo: true, includeSummary: true, includeHiddenMessages: true });
    const settings = getCurrentContextSettings();
    assert.equal(settings.includePersona, false);
    assert.equal(settings.includeWorldInfo, true);
    assert.equal(settings.includeSummary, true);
    assert.equal(settings.includeHiddenMessages, true);
});

test('replies record how much context they used and what was trimmed', async () => {
    const countWords = text => String(text || '').split(/\s+/).filter(Boolean).length;
    const chat = Array.from({ length: 20 }, (_, i) => ({ is_user: i % 2 === 0, name: i % 2 ? 'Seraphina' : 'Aria', mes: `message number ${i} with some words` }));
    setupHarness({
        chat,
        powerUserSettings: {},
        getTokenCountAsync: async text => countWords(text),
        chatCompletionSettings: { stream_openai: false, openai_max_context: 120, openai_max_tokens: 20 },
    });

    const { thread } = await ask();
    const reply = thread.messages.find(m => m.role === 'assistant');
    const stats = reply.extra.promptStats;
    assert.ok(stats, 'stats are stored on the reply');
    assert.equal(stats.tokenBudget, 100);
    assert.ok(stats.promptTokens <= 100);
    assert.ok(stats.chatMessagesTrimmed > 0, 'older messages were trimmed');
    assert.equal(stats.chatMessages + stats.chatMessagesTrimmed, 20);
    assert.equal(stats.threadMessagesTrimmed, 0);
});

test('each swipe keeps its own context stats', async () => {
    setupHarness({ getTokenCountAsync: async () => 50, chatCompletionSettings: { stream_openai: false, openai_max_context: 1000, openai_max_tokens: 0 } });
    const { thread } = await ask();
    const reply = thread.messages.find(m => m.role === 'assistant');

    const result = await generateSwipe(thread.id, reply.id);
    assert.equal(result.success, true, result.error);
    const message = getThread(thread.id).messages.find(m => m.id === reply.id);
    ensureSwipeFields(message);
    assert.equal(message.swipeExtra[1].promptStats.promptTokens, 50);

    // A legacy swipe without stats must not show the other swipe's numbers
    delete message.swipeExtra[0].promptStats;
    setActiveSwipe(thread.id, reply.id, 0);
    assert.equal(message.extra.promptStats, undefined);
});

test('prompt preview builds the next prompt without changing the thread', async () => {
    setupHarness({ chat: [{ is_user: true, name: 'Aria', mes: 'Earlier' }], getTokenCountAsync: async () => 42 });
    const thread = createThread('Preview');
    const before = JSON.stringify(getThread(thread.id));

    const preview = await buildPromptPreview(thread.id, 'What next?');
    assert.equal(JSON.stringify(getThread(thread.id)), before, 'thread unchanged');
    assert.equal(preview.messages[0].role, 'system');
    assert.match(preview.messages[0].content, /OOC PROMPT/);
    const userMessage = preview.messages.at(-1).content;
    assert.match(userMessage, /\[Message #0 \| Aria\]\nEarlier/);
    assert.match(userMessage, /--- USER QUESTION ---\n\nWhat next\?/);
    assert.equal(preview.stats.promptTokens, 42);
});

test('prompt preview for a new thread uses the settings shown in the view', async () => {
    setupHarness({ chat: [{ is_user: true, name: 'Aria', mes: 'Earlier' }] });
    const preview = await buildPromptPreview(null, 'Q', { ...getCurrentContextSettings(), characterCardOnly: true });
    const text = preview.messages.map(m => m.content).join('\n');
    assert.doesNotMatch(text, /\nEarlier\n/);
    assert.match(text, /Character Name: Seraphina/);
    assert.match(text, /Title:/, 'first message asks for a title');
});

test('preview applies regex to history and out-of-range swipes using full-chat depths', async () => {
    const chat = [
        { is_user: false, name: 'Bot', mes: 'OLDER<junk>OLD_SECRET</junk>' },
        { is_system: true, mes: 'HIDDEN' },
        { is_user: true, mes: 'USER<junk>USER_SECRET</junk>', swipes: ['USER', 'USER_ALT<junk>USER_ALT_SECRET</junk>'] },
        { is_user: false, mes: 'AI<junk>AI_SECRET</junk>', swipes: ['AI', 'AI_ALT<junk>AI_ALT_SECRET</junk>'] },
    ];
    const { calls } = setupHarness({ chat });
    regexMock.process = (text, placement, { isPrompt, depth }) => {
        assert.equal(isPrompt, true);
        return `${placement}:${depth}:${text.replace(/<junk>.*?<\/junk>/g, '')}`;
    };
    const thread = createThread('Range', {
        swipeContextMode: 'both', chatHistoryRangeMode: 'start_to', chatHistoryRangeEnd: 1,
    });
    const original = structuredClone(chat);
    const preview = await buildPromptPreview(thread.id, 'Compare');
    const text = preview.messages.map(m => m.content).join('\n');
    assert.match(text, /\[Message #0 \| Bot\]\n2:2:OLDER/);
    assert.match(text, /\[Message #2 \| Aria\]\n1:1:USER/);
    assert.match(text, /Swipe 2:\n1:1:USER_ALT/);
    assert.match(text, /Swipe 2:\n2:0:AI_ALT/);
    assert.doesNotMatch(text, /SECRET|<junk>|HIDDEN/);
    assert.equal(preview.stats.chatMessages, 3);
    assert.deepEqual(chat, original);
    assert.deepEqual(calls, [], 'preview never sends a generation request');
});

test('regex stripping happens before token budgeting and does not change depth when history is trimmed', async () => {
    const chat = [
        { is_user: true, mes: 'OLD_HISTORY '.repeat(150) },
        { is_user: false, mes: `RECENT<junk>${'STRIPPED '.repeat(1000)}</junk>` },
        { is_user: true, mes: 'LATEST' },
    ];
    const countWords = text => String(text || '').split(/\s+/).filter(Boolean).length;
    setupHarness({
        chat,
        powerUserSettings: {},
        getTokenCountAsync: async text => countWords(text),
        chatCompletionSettings: { stream_openai: false, openai_max_context: 160, openai_max_tokens: 10 },
    });
    regexMock.process = (text, placement, { depth }) => `${depth}:${text.replace(/<junk>.*?<\/junk>/g, '')}`;
    const thread = createThread('Budget', { includeCharacterCard: false });
    const preview = await buildPromptPreview(thread.id, 'Q');
    const text = preview.messages.map(m => m.content).join('\n');
    assert.doesNotMatch(text, /OLD_HISTORY|STRIPPED|<junk>/);
    assert.match(text, /\[Message #1 \| Character\]\n1:RECENT/);
    assert.match(text, /\[Message #2 \| Aria\]\n0:LATEST/);
    assert.equal(preview.stats.chatMessagesTrimmed, 1);
    assert.deepEqual(regexMock.calls.map(call => call.options.depth), [2, 1, 0]);
    assert.equal(regexMock.calls[1].placement, regex_placement.AI_OUTPUT);
    assert.ok(preview.stats.promptTokens <= 150);
});
