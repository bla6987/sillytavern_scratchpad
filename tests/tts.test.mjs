import test from 'node:test';
import assert from 'node:assert/strict';
import { regexMock } from './helpers/regex-engine.mjs';

import { autoSpeakText, speakText } from '../src/tts.js';
import { getSettings } from '../src/settings.js';
import { createThread, getThread, setActiveSwipe } from '../src/storage.js';
import { cancelGeneration, editUserMessageAndRegenerate, generateGeneralAskResponse, generateRawPromptResponse, generateScratchPadResponse, generateSwipe, generateThreadTitle, recoverInterruptedGenerations, retryMessage } from '../src/generation.js';

function harness(settings = {}, overrides = {}) {
    regexMock.reset();
    const speech = [];
    const context = {
        extensionSettings: {
            scratchPad: { useStandardGeneration: true, ttsEnabled: true, ttsAutoGenerate: true, ttsVoice: ' Narrator ', ...settings },
        },
        chatMetadata: {},
        chat: [],
        characters: [],
        characterId: 0,
        mainApi: 'openai',
        chatCompletionSettings: { stream_openai: false },
        getCurrentChatId: () => 'chat-a',
        saveMetadata: async () => {},
        saveSettingsDebounced() {},
        substituteParams: text => text,
        generateRaw: async () => '<think>Private reasoning</think>Hello **world**.',
        SlashCommandParser: {
            commands: { speak: { callback: async (args, text) => { speech.push({ args, text }); } } },
        },
        ...overrides,
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.window = {};
    return { context, speech, thread: () => createThread('TTS test') };
}

test('existing settings default automatic speech to off', () => {
    const { context } = harness();
    delete context.extensionSettings.scratchPad.ttsAutoGenerate;
    assert.equal(getSettings().ttsAutoGenerate, false);
});

test('automatic speech requires both toggles and an available TTS command', async () => {
    for (const settings of [{ ttsEnabled: false }, { ttsAutoGenerate: false }]) {
        const { speech } = harness(settings);
        assert.equal(await autoSpeakText('Hello'), false);
        assert.deepEqual(speech, []);
    }
    const { context, speech } = harness();
    context.SlashCommandParser.commands = {};
    assert.equal(await autoSpeakText('Hello'), false);
    assert.deepEqual(speech, []);
});

for (const generate of [generateScratchPadResponse, generateGeneralAskResponse, generateRawPromptResponse]) {
    test(`${generate.name} speaks the completed reply once using the selected voice`, async () => {
        const h = harness();
        const thread = h.thread();
        const result = await generate('Question', thread.id);
        assert.equal(result.success, true, result.error);
        assert.deepEqual(h.speech, [{ args: { voice: 'Narrator' }, text: 'Hello world.' }]);
        assert.equal(getThread(thread.id).messages.at(-1).status, 'complete');
    });

    test(`${generate.name} supports quiet requests with automatic TTS enabled`, async () => {
        const h = harness();
        const result = await generate('Question', h.thread().id, null, { autoTts: false });
        assert.equal(result.success, true, result.error);
        assert.deepEqual(h.speech, []);
    });

    test(`${generate.name} skips speech for failed, cancelled, or empty replies`, async () => {
        for (const outcome of ['failed', 'cancelled', 'empty']) {
            const h = harness({}, {
                generateRaw: async () => {
                    if (outcome === 'failed') throw new Error('Expected generation failure');
                    if (outcome === 'cancelled') cancelGeneration();
                    return outcome === 'empty' ? '' : 'Partial text';
                },
            });
            const result = await generate('Question', h.thread().id);
            assert.equal(result.success, outcome === 'empty');
            assert.deepEqual(h.speech, [], outcome);
        }
    });

    test(`${generate.name} skips speech if the chat changes during the final save`, async () => {
        const h = harness();
        const thread = h.thread();
        h.context.saveMetadata = async () => {
            if (getThread(thread.id).messages.at(-1)?.content) {
                h.context.getCurrentChatId = () => 'chat-b';
            }
        };
        const result = await generate('Question', thread.id);
        assert.equal(result.success, true, result.error);
        assert.deepEqual(h.speech, []);
    });
}

test('automatic speech uses the final reply without its generated title', async () => {
    const h = harness({}, { generateRaw: async () => '**Title: A title**\n\nThe actual reply.' });
    const thread = h.thread();
    assert.equal((await generateScratchPadResponse('Question', thread.id)).success, true);
    assert.equal(getThread(thread.id).name, 'A title');
    assert.equal(h.speech[0].text, 'The actual reply.');
});

test('edits, retries, and newly generated swipes speak once; selecting saved swipes and recovering do not', async () => {
    const h = harness();
    const thread = h.thread();
    await generateScratchPadResponse('Question', thread.id);
    const userId = getThread(thread.id).messages[0].id;
    assert.equal((await editUserMessageAndRegenerate(thread.id, userId, 'Edited question')).success, true);
    const reply = getThread(thread.id).messages.at(-1);
    assert.equal((await generateSwipe(thread.id, reply.id)).success, true);
    assert.equal(h.speech.length, 3);
    setActiveSwipe(thread.id, reply.id, 0);
    recoverInterruptedGenerations();
    await generateThreadTitle(getThread(thread.id));
    assert.equal(h.speech.length, 3, 'saved replies and titles do not trigger speech');
    getThread(thread.id).messages.at(-1).status = 'failed';
    assert.equal((await retryMessage(thread.id, reply.id)).success, true);
    assert.equal(h.speech.length, 4);
});

test('streaming speaks only the final text, after the response is saved', async () => {
    const h = harness({ useAlternativeApi: true, connectionProfileId: 'stream-profile', useStandardGeneration: false });
    h.context.extensionSettings.connectionManager = { profiles: [{ id: 'stream-profile', name: 'Streaming', api: 'openai' }] };
    h.context.ConnectionManagerRequestService = {
        isProfileSupported: () => true,
        sendRequest: async () => async function* () {
            yield { text: 'Hel', state: { reasoning: 'Private plan' } };
            yield { text: 'Hello world.', state: { reasoning: 'Private plan done' } };
        },
    };
    let finalSaved = false;
    const thread = h.thread();
    h.context.saveMetadata = async () => {
        finalSaved = getThread(thread.id).messages.at(-1)?.status === 'complete';
    };
    h.context.SlashCommandParser.commands.speak.callback = async (args, text) => {
        assert.equal(finalSaved, true);
        h.speech.push({ args, text });
    };
    let updates = 0;
    const result = await generateScratchPadResponse('Question', thread.id, () => {
        updates++;
        assert.deepEqual(h.speech, [], 'stream updates must not generate speech');
    });
    assert.equal(result.success, true, result.error);
    assert.equal(updates, 3);
    assert.deepEqual(h.speech, [{ args: { voice: 'Narrator' }, text: 'Hello world.' }]);
});

test('speech does not hold up the reply or the next question', { timeout: 1000 }, async () => {
    let release;
    const speechPending = new Promise(resolve => { release = resolve; });
    const h = harness({}, { SlashCommandParser: { commands: { speak: { callback: () => speechPending } } } });
    try {
        const thread = h.thread();
        assert.equal((await generateScratchPadResponse('Question', thread.id)).success, true);
        assert.equal((await generateScratchPadResponse('Follow-up', thread.id)).success, true);
    } finally {
        release();
    }
});

test('TTS provider failures cannot fail or erase a completed reply', async () => {
    const h = harness({}, {
        SlashCommandParser: { commands: { speak: { callback: async () => { throw new Error('Expected TTS failure'); } } } },
    });
    const thread = h.thread();
    const result = await generateScratchPadResponse('Question', thread.id);
    assert.equal(result.success, true, result.error);
    assert.equal(getThread(thread.id).messages.at(-1).status, 'complete');
    assert.equal(getThread(thread.id).messages.at(-1).content, 'Hello **world**.');
});

test('manual speech remains available with automatic generation off', async () => {
    const h = harness({ ttsAutoGenerate: false });
    assert.equal(await speakText('Manual speech'), true);
    assert.equal(h.speech[0].text, 'Manual speech');
});
