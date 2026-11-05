import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRawPromptResponse, generateThreadTitle, cancelGeneration, isGenerationActive } from '../src/generation.js';
import { createThread, addMessage } from '../src/storage.js';
import { streamGeneration, requestChatCompletion } from '../src/streaming.js';
import { isAbortError } from '../src/requestLifecycle.js';

function setup(overrides = {}) {
    const context = {
        extensionSettings: { scratchPad: { useStandardGeneration: false } }, chatMetadata: {}, chat: [],
        characters: [], characterId: 0, mainApi: 'openai',
        chatCompletionSettings: { stream_openai: true, chat_completion_source: 'openai', openai_max_tokens: 100 },
        saveMetadata: async () => {}, saveSettingsDebounced() {}, substituteParams: text => text,
        getChatCompletionModel: () => 'test-model', getRequestHeaders: () => ({}), getCurrentChatId: () => 'test',
        ...overrides,
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.window = {};
    return context;
}

test('a wrapped Connection Manager abort stops only its own request and never retries', async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const calls = [];
    let globalStops = 0;
    setup({
        extensionSettings: { scratchPad: { useAlternativeApi: true, connectionProfileId: 'p' }, connectionManager: { profiles: [{ id: 'p', api: 'openai', model: 'test' }] } },
        stopGeneration: () => globalStops++,
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            async sendRequest(id, messages, maxTokens, options) {
                calls.push(options);
                started();
                try {
                    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
                } catch (error) { throw new Error('API request failed', { cause: error }); }
            },
        },
    });
    const thread = createThread('Cancel');
    const task = generateRawPromptResponse('Question', thread.id, () => {});
    await ready;
    assert.equal(cancelGeneration(), true);
    const result = await task;
    assert.equal(result.cancelled, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(globalStops, 0);
    assert.equal(isGenerationActive(), false);
    assert.equal(thread.messages.some(message => message.role === 'assistant'), false);
});

test('wrapped abort detection handles nested causes and cycles', () => {
    const wrapped = new Error('API request failed', { cause: new Error('wrapper', { cause: new DOMException('stopped', 'AbortError') }) });
    assert.equal(isAbortError(wrapped), true);
    const cycle = new Error('failed'); cycle.cause = cycle;
    assert.equal(isAbortError(cycle), false);
});

for (const partial of ['', 'Partial reply']) {
    test(`an HTTP 200 stream error fails the turn without retrying (${partial || 'empty'})`, async () => {
        setup();
        let calls = 0;
        const previousFetch = globalThis.fetch;
        globalThis.fetch = async () => {
            calls++;
            return new Response(`${partial ? `data: ${JSON.stringify({ choices: [{ delta: { content: partial } }] })}\n\n` : ''}data: {"error":{"message":"provider overloaded"}}\n\ndata: [DONE]\n\n`);
        };
        try {
            const thread = createThread('Stream error');
            const result = await generateRawPromptResponse('Question', thread.id, () => {});
            assert.equal(result.success, false);
            assert.match(result.error, /provider overloaded/);
            assert.equal(thread.messages.at(-1).status, 'failed');
            assert.equal(calls, 1);
        } finally { globalThis.fetch = previousFetch; }
    });
}

test('host adapter owns settings conversion, cumulative stream parsing and cancellation', async () => {
    const calls = [];
    const context = setup({
        chatCompletionSettings: { stream_openai: true, chat_completion_source: 'workers_ai', workers_ai_account_id: 'account-123', temp_openai: 0.4 },
        ChatCompletionService: {
            async presetToGeneratePayload(settings, overrides, payload) {
                calls.push({ settings, overrides, payload });
                return { ...payload, workers_ai_account_id: settings.workers_ai_account_id, temperature: settings.temp_openai, tools: ['main tool'], char_name: 'private character' };
            },
            async sendRequest(payload, extract, signal) {
                calls.push({ payload, extract, signal });
                if (!payload.stream) return { content: 'Plain reply', reasoning: 'Reasoning' };
                return async function* () {
                    yield { text: 'Hello', state: { reasoning: 'Think' } };
                    yield { text: 'Hello world', state: { reasoning: 'Thinking' } };
                };
            },
        },
    });
    const controller = new AbortController();
    const messages = [{ role: 'user', content: 'Question' }];
    const chunks = [];
    for await (const chunk of streamGeneration({ messages, signal: controller.signal })) chunks.push(chunk);
    assert.deepEqual(chunks, [{ text: 'Hello', reasoning: 'Think' }, { text: ' world', reasoning: 'ing' }]);
    assert.notEqual(calls[0].settings, context.chatCompletionSettings);
    assert.equal(calls[1].payload.workers_ai_account_id, 'account-123');
    assert.equal(calls[1].payload.tools, undefined);
    assert.equal(calls[1].payload.char_name, '');
    assert.equal(calls[1].signal, controller.signal);
    assert.deepEqual(await requestChatCompletion({ messages, signal: controller.signal }), { content: 'Plain reply', reasoning: 'Reasoning' });
});

test('host parser failures stay failures without switching transport', async () => {
    let calls = 0;
    setup({ ChatCompletionService: {
        presetToGeneratePayload: async (_, __, payload) => payload,
        sendRequest: async () => {
            calls++;
            return async function* () { yield { text: 'Partial', state: {} }; throw new Error('Provider stream failed'); };
        },
    } });
    const thread = createThread('Host failure');
    const result = await generateRawPromptResponse('Question', thread.id, () => {});
    assert.equal(result.success, false);
    assert.equal(thread.messages.at(-1).status, 'failed');
    assert.equal(calls, 1);
});

test('legacy Workers AI streaming includes the required account id', async () => {
    setup({ chatCompletionSettings: { stream_openai: true, chat_completion_source: 'workers_ai', workers_ai_account_id: 'account-123' } });
    const original = globalThis.fetch;
    let body;
    globalThis.fetch = async (_, options) => { body = JSON.parse(options.body); return new Response('data: [DONE]\n\n'); };
    try {
        for await (const _ of streamGeneration({ messages: [{ role: 'user', content: 'Question' }] })) {}
        assert.equal(body.workers_ai_account_id, 'account-123');
    } finally { globalThis.fetch = original; }
});

test('cancelling an AI title cannot cancel the following question', async () => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const context = setup({ extensionSettings: { scratchPad: { useStandardGeneration: true } },
        generateRaw: () => { started(); return new Promise(() => {}); } });
    const thread = createThread('Title'); addMessage(thread.id, 'user', 'Question');
    const title = generateThreadTitle(thread);
    await ready;
    cancelGeneration();
    assert.equal((await title).success, false);
    context.generateRaw = async () => 'Next response';
    const result = await generateRawPromptResponse('Next question', thread.id);
    assert.equal(result.success, true);
    assert.equal(result.response, 'Next response');
});

test('legacy generateRaw cancellation discards its late result without stopping main chat', async () => {
    let finish, started;
    const ready = new Promise(resolve => { started = resolve; });
    let globalStops = 0;
    setup({ extensionSettings: { scratchPad: { useStandardGeneration: true } },
        stopGeneration: () => globalStops++,
        generateRaw: () => { started(); return new Promise(resolve => { finish = resolve; }); },
    });
    const thread = createThread('Legacy');
    const task = generateRawPromptResponse('Question', thread.id);
    await ready;
    cancelGeneration();
    assert.equal((await task).cancelled, true);
    finish('Late reply');
    await Promise.resolve();
    assert.equal(globalStops, 0);
    assert.equal(thread.messages.some(message => message.content === 'Late reply'), false);
});
