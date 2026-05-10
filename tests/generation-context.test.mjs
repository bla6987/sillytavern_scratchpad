import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';

import { generateScratchPadResponse, isChatActive } from '../src/generation.js';
import { createThread, updateThreadContextSettings, addMessage, getThread } from '../src/storage.js';
import { streamGeneration } from '../src/streaming.js';

function setupHarness(overrides = {}) {
    const calls = [];
    const context = {
        extensionSettings: {},
        chatMetadata: {},
        chat: [],
        characters: [],
        characterId: 0,
        groupId: undefined,
        mainApi: 'openai',
        chatCompletionSettings: { stream_openai: false },
        saveMetadata: async () => {},
        saveSettingsDebounced: () => {},
        setExtensionPrompt: (...args) => calls.push(args),
        substituteParams: (text) => text,
        sendGenerationRequest: async (type, data) => {
            calls.push(['sendGenerationRequest', type, data]);
            return { choices: [{ message: { content: 'Assistant response' } }] };
        },
        extractMessageFromData: () => 'Assistant response',
        generateRaw: async (args) => {
            calls.push(['generateRaw', args]);
            return 'Assistant response';
        },
        ...overrides,
    };

    context.extensionSettings.scratchPad = {
        useStandardGeneration: true,
        oocSystemPrompt: 'OOC PROMPT',
        chatHistoryLimit: 0,
        ...(context.extensionSettings.scratchPad || {}),
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

    const rawCall = calls.find(args => args[0] === 'generateRaw');
    assert.ok(rawCall, 'should generate through generateRaw');

    return rawCall[1];
}

test('isChatActive allows empty chats for active character/group', () => {
    setupHarness({ chat: [], characterId: 1, groupId: undefined });
    assert.equal(isChatActive(), true);

    setupHarness({ chat: [], characterId: undefined, groupId: 'group-1' });
    assert.equal(isChatActive(), true);

    setupHarness({ chat: [], characterId: undefined, groupId: undefined });
    assert.equal(isChatActive(), false);
});

test('standard generation uses controlled scratch pad context without duplicating the current question', async () => {
    const rawArgs = await runStandardGeneration({
        contextOverrides: {
            chatMetadata: {
                system_prompt: 'ST SYSTEM PROMPT',
                note_prompt: 'AUTHOR NOTE',
            },
            chat: [
                { is_user: true, name: 'User', mes: 'Visible chat history' },
            ],
            characters: [
                { name: 'Seraphina', description: 'Character card text' },
            ],
            extensionSettings: {
                scratchPad: {
                    useStandardGeneration: true,
                    oocSystemPrompt: 'OOC PROMPT',
                    chatHistoryLimit: 0,
                },
            },
        },
        threadSettings: {
            includeSystemPrompt: true,
            includeCharacterCard: true,
            includeAuthorsNote: true,
        },
        seedMessages: [
            { role: 'user', content: 'Older thread question' },
            { role: 'assistant', content: 'Older thread answer' },
        ],
    });

    assert.equal(rawArgs.systemPrompt.includes('OOC PROMPT'), true);
    assert.match(rawArgs.prompt, /--- SYSTEM PROMPT ---/);
    assert.match(rawArgs.prompt, /ST SYSTEM PROMPT/);
    assert.match(rawArgs.prompt, /--- CHARACTER INFORMATION ---/);
    assert.match(rawArgs.prompt, /Character card text/);
    assert.match(rawArgs.prompt, /--- AUTHOR'S NOTE ---/);
    assert.match(rawArgs.prompt, /AUTHOR NOTE/);
    assert.match(rawArgs.prompt, /--- ROLEPLAY CHAT HISTORY ---/);
    assert.match(rawArgs.prompt, /Visible chat history/);
    assert.match(rawArgs.prompt, /--- PREVIOUS SCRATCH PAD DISCUSSION ---/);
    assert.match(rawArgs.prompt, /Older thread question/);
    assert.match(rawArgs.prompt, /Older thread answer/);
    assert.match(rawArgs.prompt, /--- USER QUESTION ---/);

    const occurrences = rawArgs.prompt.match(/New question/g) || [];
    assert.equal(occurrences.length, 1);
});

test('custom generation does not duplicate the current question in thread history', async () => {
    const { calls } = setupHarness({
        extensionSettings: {
            scratchPad: {
                useStandardGeneration: false,
                oocSystemPrompt: 'OOC PROMPT',
                chatHistoryLimit: 0,
            },
        },
    });

    const thread = createThread('Custom Thread');
    assert.ok(thread, 'thread should be created');

    const result = await generateScratchPadResponse('Unique custom question', thread.id);
    assert.equal(result.success, true);

    const requestCall = calls.find(args => args[0] === 'sendGenerationRequest');
    assert.ok(requestCall, 'should generate through sendGenerationRequest');
    const userPrompt = requestCall[2].prompt.find(message => message.role === 'user').content;
    const occurrences = userPrompt.match(/Unique custom question/g) || [];
    assert.equal(occurrences.length, 1);
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

test('streaming parser emits CRLF-delimited SSE events before stream close', async () => {
    setupHarness({
        chatCompletionSettings: {
            stream_openai: true,
            chat_completion_source: 'openai',
            temp_openai: 1,
            freq_pen_openai: 0,
            pres_pen_openai: 0,
            top_p_openai: 1,
            openai_max_tokens: 100,
            show_thoughts: false,
            reasoning_effort: 'auto',
            seed: -1,
        },
        getChatCompletionModel: () => 'test-model',
        getRequestHeaders: () => ({}),
    });

    let controller;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        body: new ReadableStream({
            start(streamController) {
                controller = streamController;
            },
        }),
    });

    try {
        const iterator = streamGeneration({ messages: [{ role: 'user', content: 'Hi' }] });
        const nextToken = iterator.next();
        await new Promise(resolve => setTimeout(resolve, 0));

        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\n'));

        const result = await Promise.race([
            nextToken,
            new Promise(resolve => setTimeout(() => resolve(null), 100)),
        ]);

        assert.deepEqual(result, { value: { text: 'Hello', reasoning: '' }, done: false });
        controller.close();
    } finally {
        globalThis.fetch = previousFetch;
    }
});
