import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';

import { GENERAL_ASK_SYSTEM_PROMPT, editUserMessageAndRegenerate, generateGeneralAskResponse, generateRawPromptResponse, generateScratchPadResponse, generateSwipe, isChatActive, retryMessage } from '../src/generation.js';
import { createThread, updateThreadContextSettings, addMessage, getThread } from '../src/storage.js';
import { getConnectionProfiles, getSettings } from '../src/settings.js';
import { renderConnectionProfileOptions } from '../src/connectionProfiles.js';
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

test('standard generation trims oldest context to fit SillyTavern prompt budget', async () => {
    const countWords = (text) => String(text || '').split(/\s+/).filter(Boolean).length;
    const rawArgs = await runStandardGeneration({
        contextOverrides: {
            chatCompletionSettings: {
                stream_openai: false,
                openai_max_context: 70,
                openai_max_tokens: 10,
            },
            getTokenCountAsync: async (text) => countWords(text),
            chat: [
                {
                    is_user: true,
                    name: 'User',
                    mes: 'old chat marker alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron',
                },
                { is_user: false, name: 'Bot', mes: 'middle chat marker' },
                { is_user: true, name: 'User', mes: 'recent chat marker' },
            ],
            extensionSettings: {
                scratchPad: {
                    useStandardGeneration: true,
                    oocSystemPrompt: 'OOC',
                    chatHistoryLimit: 0,
                },
            },
        },
    });

    assert.equal(rawArgs.prompt.includes('old chat marker'), false);
    assert.equal(rawArgs.prompt.includes('middle chat marker'), true);
    assert.equal(rawArgs.prompt.includes('recent chat marker'), true);
    assert.ok(countWords(`${rawArgs.systemPrompt}\n\n${rawArgs.prompt}`) <= 60);
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

test('general ask uses only minimal assistant prompt and user question', async () => {
    const { calls } = setupHarness({
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
    });

    const thread = createThread('General Ask Thread');
    assert.ok(thread, 'thread should be created');
    updateThreadContextSettings(thread.id, {
        includeSystemPrompt: true,
        includeCharacterCard: true,
        includeAuthorsNote: true,
    });
    addMessage(thread.id, 'user', 'Older thread question', 'complete', 0);
    addMessage(thread.id, 'assistant', 'Older thread answer', 'complete', 0);

    const result = await generateGeneralAskResponse('General knowledge question', thread.id);
    assert.equal(result.success, true);

    const rawCall = calls.find(args => args[0] === 'generateRaw');
    assert.ok(rawCall, 'should generate through generateRaw');
    const rawArgs = rawCall[1];

    assert.equal(rawArgs.systemPrompt, GENERAL_ASK_SYSTEM_PROMPT);
    assert.equal(rawArgs.prompt, 'General knowledge question');
    assert.equal((rawArgs.prompt.match(/General knowledge question/g) || []).length, 1);
    assert.equal(rawArgs.prompt.includes('Visible chat history'), false);
    assert.equal(rawArgs.prompt.includes('Character card text'), false);
    assert.equal(rawArgs.prompt.includes('AUTHOR NOTE'), false);
    assert.equal(rawArgs.prompt.includes('Older thread question'), false);
    assert.equal(rawArgs.prompt.includes('Older thread answer'), false);
    assert.equal(rawArgs.systemPrompt.includes('OOC PROMPT'), false);
    assert.equal(rawArgs.systemPrompt.includes('Title:'), false);

    const savedThread = getThread(thread.id);
    assert.equal(savedThread.messages[2].noContext, true);
    assert.equal(savedThread.messages[3].noContext, true);
});

test('raw prompt sends no system prompt and no injected context', async () => {
    const { calls } = setupHarness({
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
    });

    const thread = createThread('Raw Prompt Thread');
    assert.ok(thread, 'thread should be created');
    addMessage(thread.id, 'user', 'Older thread question', 'complete', 0);
    addMessage(thread.id, 'assistant', 'Older thread answer', 'complete', 0);

    const result = await generateRawPromptResponse('Raw direct prompt', thread.id);
    assert.equal(result.success, true);

    const rawCall = calls.find(args => args[0] === 'generateRaw');
    assert.ok(rawCall, 'should generate through generateRaw');
    const rawArgs = rawCall[1];

    assert.equal(rawArgs.systemPrompt, '');
    assert.equal(rawArgs.prompt, 'Raw direct prompt');
    assert.equal(rawArgs.prompt.includes('Visible chat history'), false);
    assert.equal(rawArgs.prompt.includes('Character card text'), false);
    assert.equal(rawArgs.prompt.includes('AUTHOR NOTE'), false);
    assert.equal(rawArgs.prompt.includes('Older thread question'), false);
    assert.equal(rawArgs.prompt.includes('Older thread answer'), false);
});

test('profile generation uses Connection Manager profile ID without slash profile switching', async () => {
    const { calls } = setupHarness({
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: {
                profiles: [{ id: 'profile-1', name: 'Writer Profile', api: 'openai', model: 'profile-model' }],
            },
            scratchPad: {
                useAlternativeApi: true,
                connectionProfileId: 'profile-1',
                useStandardGeneration: false,
                oocSystemPrompt: 'OOC PROMPT',
            },
        },
        executeSlashCommandsWithOptions: async (...args) => {
            calls.push(['slash', ...args]);
            throw new Error('slash profile switching should not be used');
        },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            sendRequest: async (...args) => {
                calls.push(['profileSendRequest', ...args]);
                return { content: 'Profile response', reasoning: 'Profile reasoning' };
            },
        },
    });

    const thread = createThread('Profile Thread');
    const result = await generateScratchPadResponse('Profile question', thread.id);
    assert.equal(result.success, true);
    assert.equal(result.response, 'Profile response');
    assert.equal(result.thinking, 'Profile reasoning');
    assert.deepEqual(result.generationInfo, { api: 'openai', model: 'profile-model' });

    const savedAssistant = getThread(thread.id).messages.find(msg => msg.role === 'assistant');
    assert.equal(savedAssistant.extra.api, 'openai');
    assert.equal(savedAssistant.extra.model, 'profile-model');

    const profileCall = calls.find(args => args[0] === 'profileSendRequest');
    assert.ok(profileCall, 'should send through Connection Manager');
    assert.equal(profileCall[1], 'profile-1');
    assert.equal(profileCall[3], undefined);
    assert.equal(profileCall[4].stream, false);
    assert.equal(profileCall[4].includePreset, true);
    assert.equal(calls.some(args => args[0] === 'slash'), false);
});

test('forced global profile overrides thread-level API selections', async () => {
    const { calls } = setupHarness({
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: {
                profiles: [
                    { id: 'global-profile', name: 'Global Profile', api: 'openai', model: 'global-model' },
                    { id: 'thread-profile', name: 'Thread Profile', api: 'openai', model: 'thread-model' },
                ],
            },
            scratchPad: {
                useAlternativeApi: true,
                forceGlobalApiProfile: true,
                connectionProfileId: 'global-profile',
                useStandardGeneration: false,
                oocSystemPrompt: 'OOC PROMPT',
            },
        },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            sendRequest: async (...args) => {
                calls.push(['profileSendRequest', ...args]);
                return { content: 'Profile response', reasoning: '' };
            },
        },
    });

    const thread = createThread('Forced Profile Thread');
    updateThreadContextSettings(thread.id, {
        connectionProfileId: 'thread-profile',
        connectionProfile: null,
    });

    const result = await generateScratchPadResponse('Forced profile question', thread.id);
    assert.equal(result.success, true);

    const profileCall = calls.find(args => args[0] === 'profileSendRequest');
    assert.ok(profileCall, 'should send through Connection Manager');
    assert.equal(profileCall[1], 'global-profile');
});

test('forced global profile ignores thread profile when no global profile is selected', async () => {
    const { calls } = setupHarness({
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: {
                profiles: [{ id: 'thread-profile', name: 'Thread Profile', api: 'openai', model: 'thread-model' }],
            },
            scratchPad: {
                useAlternativeApi: true,
                forceGlobalApiProfile: true,
                connectionProfileId: '',
                useStandardGeneration: true,
                oocSystemPrompt: 'OOC PROMPT',
            },
        },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            sendRequest: async (...args) => {
                calls.push(['profileSendRequest', ...args]);
                return { content: 'Profile response', reasoning: '' };
            },
        },
    });

    const thread = createThread('Blank Forced Profile Thread');
    updateThreadContextSettings(thread.id, {
        connectionProfileId: 'thread-profile',
        connectionProfile: null,
    });

    const result = await generateScratchPadResponse('Blank forced profile question', thread.id);
    assert.equal(result.success, true);
    assert.equal(calls.some(args => args[0] === 'profileSendRequest'), false);
    assert.ok(calls.some(args => args[0] === 'generateRaw'), 'should fall back to active API generation');
});

test('legacy connection profile names migrate to profile IDs', async () => {
    setupHarness({
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: {
                profiles: [{ id: 'legacy-id', name: 'Legacy Profile', api: 'openai' }],
            },
            scratchPad: {
                useAlternativeApi: true,
                connectionProfile: 'Legacy Profile',
            },
        },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            sendRequest: async () => ({ content: 'ok', reasoning: '' }),
        },
    });

    const settings = getSettings();
    assert.equal(settings.connectionProfileId, 'legacy-id');
    assert.equal(settings.connectionProfile, '');

    const profiles = await getConnectionProfiles();
    assert.deepEqual(profiles.map(profile => profile.id), ['legacy-id']);
});

test('connection profile dropdown renders stable profile IDs as option values', () => {
    setupHarness({
        CONNECT_API_MAP: {
            openai: { selected: 'openai' },
        },
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: {
                profiles: [
                    { id: 'profile-one', name: 'Profile One', api: 'openai' },
                    { id: 'profile-two', name: 'Profile Two', api: 'openai' },
                ],
            },
            scratchPad: {},
        },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
        },
    });

    const previousDocument = globalThis.document;
    const createElement = (tagName) => ({
        tagName: tagName.toUpperCase(),
        children: [],
        disabled: false,
        value: '',
        textContent: '',
        label: '',
        appendChild(child) {
            this.children.push(child);
        },
    });
    const select = createElement('select');
    Object.defineProperty(select, 'innerHTML', {
        set() {
            this.children = [];
        },
    });
    select.appendChild = function appendChild(child) {
        this.children.push(child);
    };

    globalThis.document = { createElement };
    try {
        const result = renderConnectionProfileOptions(select, 'Profile Two');
        assert.equal(result.selectedId, 'profile-two');
        assert.equal(select.value, 'profile-two');

        const optionValues = select.children
            .flatMap(child => child.children?.length ? child.children : [child])
            .map(option => option.value);
        assert.deepEqual(optionValues, ['', 'profile-one', 'profile-two']);
    } finally {
        globalThis.document = previousDocument;
    }
});

test('missing profile falls back to active API generation', async () => {
    const { calls } = setupHarness({
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: { profiles: [] },
            scratchPad: {
                useAlternativeApi: true,
                connectionProfileId: 'missing-profile',
                useStandardGeneration: true,
                oocSystemPrompt: 'OOC PROMPT',
            },
        },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            sendRequest: async (...args) => {
                calls.push(['profileSendRequest', ...args]);
                return { content: 'should not use profile', reasoning: '' };
            },
        },
    });

    const thread = createThread('Fallback Thread');
    const result = await generateScratchPadResponse('Fallback question', thread.id);
    assert.equal(result.success, true);

    assert.ok(calls.some(args => args[0] === 'generateRaw'), 'should fall back to active API generation');
    assert.equal(calls.some(args => args[0] === 'profileSendRequest'), false);
});

test('profile streaming updates tokens and stores streamed reasoning', async () => {
    const { calls } = setupHarness({
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: {
                profiles: [{ id: 'stream-profile', name: 'Stream Profile', api: 'openai' }],
            },
            scratchPad: {
                useAlternativeApi: true,
                connectionProfileId: 'stream-profile',
                useStandardGeneration: false,
                oocSystemPrompt: 'OOC PROMPT',
            },
        },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            sendRequest: async (...args) => {
                calls.push(['profileSendRequest', ...args]);
                return async function* streamData() {
                    yield { text: 'Hel', state: { reasoning: 'Plan' } };
                    yield { text: 'Hello', state: { reasoning: 'Plan done' } };
                };
            },
        },
    });

    const streamEvents = [];
    const thread = createThread('Streaming Thread');
    const result = await generateScratchPadResponse('Stream question', thread.id, (text, done) => {
        streamEvents.push({ text, done });
    });

    assert.equal(result.success, true);
    assert.equal(result.response, 'Hello');
    assert.equal(result.thinking, 'Plan done');
    assert.deepEqual(streamEvents, [
        { text: 'Hel', done: false },
        { text: 'Hello', done: false },
        { text: 'Hello', done: true },
    ]);

    const profileCall = calls.find(args => args[0] === 'profileSendRequest');
    assert.equal(profileCall[4].stream, true);
});

test('profile streaming failure retries once without streaming', async () => {
    const { calls } = setupHarness({
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: {
                profiles: [{ id: 'retry-profile', name: 'Retry Profile', api: 'openai' }],
            },
            scratchPad: {
                useAlternativeApi: true,
                connectionProfileId: 'retry-profile',
                useStandardGeneration: false,
                oocSystemPrompt: 'OOC PROMPT',
            },
        },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            sendRequest: async (...args) => {
                calls.push(['profileSendRequest', ...args]);
                if (args[3].stream) {
                    throw new Error('stream failed');
                }
                return { content: 'Retry response', reasoning: 'Retry reasoning' };
            },
        },
    });

    const thread = createThread('Retry Thread');
    const result = await generateScratchPadResponse('Retry question', thread.id, () => {});
    assert.equal(result.success, true);
    assert.equal(result.response, 'Retry response');
    assert.equal(result.thinking, 'Retry reasoning');

    const streamFlags = calls
        .filter(args => args[0] === 'profileSendRequest')
        .map(args => args[4].stream);
    assert.deepEqual(streamFlags, [true, false]);
});

test('retry recovers from stale failed message id after no-response API failures', async () => {
    let attempts = 0;
    setupHarness({
        generateRaw: async () => {
            attempts++;
            if (attempts < 3) {
                throw new Error(`api failed ${attempts}`);
            }
            return 'Recovered response';
        },
    });

    const thread = createThread('Retry Failure Thread');
    const firstResult = await generateScratchPadResponse('Retry this question', thread.id);
    assert.equal(firstResult.success, false);
    assert.equal(firstResult.error, 'api failed 1');

    const firstFailedMessage = getThread(thread.id).messages.find(msg => msg.role === 'assistant');
    assert.ok(firstFailedMessage, 'first failure should leave a failed assistant message');

    const secondResult = await retryMessage(thread.id, firstFailedMessage.id);
    assert.equal(secondResult.success, false);
    assert.equal(secondResult.error, 'api failed 2');

    const secondFailedMessage = getThread(thread.id).messages.find(msg => msg.role === 'assistant');
    assert.notEqual(secondFailedMessage.id, firstFailedMessage.id, 'retry replaces the failed assistant message');

    const recoveredResult = await retryMessage(thread.id, firstFailedMessage.id);
    assert.equal(recoveredResult.success, true);
    assert.equal(recoveredResult.response, 'Recovered response');

    const messages = getThread(thread.id).messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].status, 'complete');
    assert.equal(messages[1].content, 'Recovered response');
});

test('editing a user message truncates later messages and regenerates from prior context', async () => {
    const { calls } = setupHarness();

    const thread = createThread('Edit Thread');
    assert.ok(thread, 'thread should be created');

    const olderUser = addMessage(thread.id, 'user', 'Older question', 'complete', 0);
    const olderAssistant = addMessage(thread.id, 'assistant', 'Older answer', 'complete', 0);
    const editedUser = addMessage(thread.id, 'user', 'Original middle question', 'complete', 0);
    addMessage(thread.id, 'assistant', 'Stale middle answer', 'complete', 0);
    addMessage(thread.id, 'user', 'Later question', 'complete', 0);
    addMessage(thread.id, 'assistant', 'Later answer', 'complete', 0);
    assert.ok(olderUser);
    assert.ok(olderAssistant);
    assert.ok(editedUser);

    const result = await editUserMessageAndRegenerate(thread.id, editedUser.id, 'Edited middle question');
    assert.equal(result.success, true);

    const messages = getThread(thread.id).messages;
    assert.equal(messages.length, 4);
    assert.equal(messages[0].id, olderUser.id);
    assert.equal(messages[1].id, olderAssistant.id);
    assert.equal(messages[2].id, editedUser.id);
    assert.equal(messages[2].content, 'Edited middle question');
    assert.ok(messages[2].editedAt, 'edited user message should record editedAt');
    assert.equal(messages[3].role, 'assistant');
    assert.equal(messages[3].content, 'Assistant response');

    const rawCall = calls.find(args => args[0] === 'generateRaw');
    assert.ok(rawCall, 'should generate through generateRaw');
    const rawArgs = rawCall[1];

    assert.match(rawArgs.prompt, /Older question/);
    assert.match(rawArgs.prompt, /Older answer/);
    assert.match(rawArgs.prompt, /Edited middle question/);
    assert.equal(rawArgs.prompt.includes('Original middle question'), false);
    assert.equal(rawArgs.prompt.includes('Stale middle answer'), false);
    assert.equal(rawArgs.prompt.includes('Later question'), false);
    assert.equal(rawArgs.prompt.includes('Later answer'), false);
    assert.equal((rawArgs.prompt.match(/Edited middle question/g) || []).length, 1);
});

test('standard generation stores response timing and model metadata on assistant messages', async () => {
    setupHarness({
        chatCompletionSettings: {
            stream_openai: false,
            chat_completion_source: 'openrouter',
        },
        getChatCompletionModel: () => 'test-model',
    });

    const thread = createThread('Timing Thread');
    assert.ok(thread, 'thread should be created');

    const result = await generateScratchPadResponse('Timed question', thread.id);
    assert.equal(result.success, true);

    const updatedThread = getThread(thread.id);
    const assistantMessage = updatedThread.messages.find(msg => msg.role === 'assistant');

    assert.ok(assistantMessage.gen_started);
    assert.ok(assistantMessage.gen_finished);
    assert.ok(Date.parse(assistantMessage.gen_started) <= Date.parse(assistantMessage.gen_finished));
    assert.deepEqual(result.generationInfo, { api: 'openrouter', model: 'test-model' });
    assert.equal(assistantMessage.extra.api, 'openrouter');
    assert.equal(assistantMessage.extra.model, 'test-model');
});

test('swipe generation stores model metadata per swipe', async () => {
    setupHarness({
        chatCompletionSettings: {
            stream_openai: false,
            chat_completion_source: 'claude',
        },
        getChatCompletionModel: () => 'claude-test-model',
    });

    const thread = createThread('Swipe Model Thread');
    const userMessage = addMessage(thread.id, 'user', 'Original question', 'complete', 0);
    const assistantMessage = addMessage(thread.id, 'assistant', 'Original answer', 'complete', 0);
    assert.ok(userMessage);
    assert.ok(assistantMessage);

    const result = await generateSwipe(thread.id, assistantMessage.id);
    assert.equal(result.success, true);

    const updatedAssistant = getThread(thread.id).messages.find(msg => msg.id === assistantMessage.id);
    assert.equal(updatedAssistant.swipeExtra[1].api, 'claude');
    assert.equal(updatedAssistant.swipeExtra[1].model, 'claude-test-model');
    assert.equal(updatedAssistant.extra.api, 'claude');
    assert.equal(updatedAssistant.extra.model, 'claude-test-model');
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

test('streaming request uses GPT-5 compatible token and sampling parameters', async () => {
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
        getChatCompletionModel: () => 'gpt-5.4',
        getRequestHeaders: () => ({}),
    });

    let requestBody;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
            ok: true,
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                    controller.close();
                },
            }),
        };
    };

    try {
        const chunks = [];
        for await (const chunk of streamGeneration({ messages: [{ role: 'user', content: 'Hi' }] })) {
            chunks.push(chunk);
        }

        assert.deepEqual(chunks, []);
        assert.equal(requestBody.max_tokens, undefined);
        assert.equal(requestBody.max_completion_tokens, 100);
        assert.equal(requestBody.temperature, undefined);
        assert.equal(requestBody.top_p, undefined);
        assert.equal(requestBody.frequency_penalty, undefined);
        assert.equal(requestBody.presence_penalty, undefined);
    } finally {
        globalThis.fetch = previousFetch;
    }
});
