import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { regexMock } from './helpers/regex-engine.mjs';
import { buildDebugSnapshot, DEBUG_SYSTEM_PROMPT } from '../src/debugContext.js';
import { THREAD_MODE, isDebugThread } from '../src/threadModes.js';
import { createThread, addMessage, forkThread, getThread, updateThread, updateThreadContextSettings } from '../src/storage.js';
import { threadsToJson, parseThreadImport, threadToMarkdown } from '../src/threadExport.js';
import { buildPromptPreview, generateScratchPadResponse, generateSwipe, editUserMessageAndRegenerate, retryMessage } from '../src/generation.js';
import { getSettings } from '../src/settings.js';

function harness(overrides = {}) {
    regexMock.reset();
    const requests = [];
    const context = {
        chat: [{ mes: 'PRIVATE_STORY', is_user: true }, { mes: 'PRIVATE_REPLY', extra: { memory: 'PRIVATE_SUMMARY' } }],
        chatMetadata: { system_prompt: 'PRIVATE_SYSTEM', note_prompt: 'PRIVATE_NOTE' },
        characters: [{ name: 'PRIVATE_CHARACTER_NAME', description: 'PRIVATE_CARD' }], characterId: 0,
        name1: 'PRIVATE_PERSONA_NAME', name2: 'PRIVATE_CHARACTER_NAME',
        getCurrentChatId: () => 'fixture-chat',
        mainApi: 'openai', maxContext: 32000,
        getChatCompletionModel: () => 'fixture-model',
        chatCompletionSettings: { chat_completion_source: 'openai', temp_openai: 0.7, openai_max_context: 32000, openai_max_tokens: 800, proxy_password: 'PRIVATE_PROXY_PASSWORD', custom_include_headers: 'PRIVATE_HEADERS', custom_include_body: 'PRIVATE_BODY', custom_url: 'https://PRIVATE_URL/?key=PRIVATE_KEY', prompts: [{ identifier: 'main', role: 'system', content: 'PRIVATE_PROMPT' }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }] },
        powerUserSettings: { persona_description: 'PRIVATE_PERSONA', sysprompt: { enabled: true, content: 'PRIVATE_INSTRUCTION' }, context: { story_string: 'PRIVATE_TEMPLATE' } },
        extensionSettings: { scratchPad: { useStandardGeneration: true, oocSystemPrompt: 'PRIVATE_OOC', includeWorldInfo: true }, chat_manager: { embeddings: { apiKey: 'PRIVATE_EMBEDDING_KEY' } } },
        extensionPrompts: { private: { value: 'PRIVATE_INJECTION', depth: 2, role: 0 } },
        saveMetadata: async () => {}, saveSettingsDebounced() {},
        substituteParams() { throw new Error('Diagnostics must not expand story macros'); },
        getWorldInfoPrompt() { throw new Error('Diagnostics must not scan story lore'); },
        sendGenerationRequest: async (type, data) => { requests.push(data.prompt); return {}; },
        extractMessageFromData: () => 'Diagnostic answer',
        generateRaw: async args => { requests.push(args); return 'Diagnostic answer'; },
        ...overrides,
    };
    globalThis.SillyTavern = { getContext: () => context, libs: {} };
    globalThis.window = {};
    return { context, requests, thread: () => createThread('Troubleshooting', null, THREAD_MODE.DEBUG) };
}

function snapshotFrom(messages) {
    const text = messages.at(-1).content;
    return JSON.parse(text.split('--- CURRENT CONFIGURATION SNAPSHOT (REFERENCE DATA) ---\n')[1].split('\n\n--- TROUBLESHOOTING QUESTION ---')[0]);
}

test('snapshot allowlist excludes story text, credentials, URLs and arbitrary plugin settings', () => {
    const { context } = harness();
    const before = JSON.stringify(context);
    const data = buildDebugSnapshot(context, { runtime: {
        worldInfo: { world_info_depth: 4, world_info_budget: 25, world_info: { entries: 'PRIVATE_LORE' } },
        extensions: [{ id: 'regex', version: '2.0' }],
        regexScripts: [{ findRegex: 'PRIVATE_PATTERN', replaceString: 'PRIVATE_REPLACEMENT', placement: [1, 2], promptOnly: true }],
    } });
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
    assert.equal(data.mainConnection.generation.temp_openai, 0.7);
    assert.equal(data.mainConnection.customHeadersConfigured, true);
    assert.equal(data.promptManager.entries[0].contentCharacters, 'PRIVATE_PROMPT'.length);
    assert.equal(data.worldInfo.world_info_depth, 4);
    assert.equal(data.regex.scripts[0].promptOnly, true);
    assert.equal(JSON.stringify(context), before, 'snapshot reads must not change configuration');
});

test('labels cannot smuggle obvious credentials, URLs, or executable macros', () => {
    const { context } = harness({ getChatCompletionModel: () => 'sk-abcdefghijklmnop' });
    context.chatCompletionSettings.preset_settings_openai = '{{setvar::x::1}}';
    const data = buildDebugSnapshot(context, { profile: { name: 'https://secret.invalid/key', api: 'openai' } });
    assert.equal(data.mainConnection.model, '[redacted label]');
    assert.equal(data.troubleshootingConnection.profile.name, '[redacted label]');
    assert.doesNotMatch(JSON.stringify(data), /\{\{|secret\.invalid|sk-abcdef/);
});

test('debug preview and generation bypass every story toggle, and only include their own discussion', async () => {
    const h = harness();
    const thread = h.thread();
    updateThreadContextSettings(thread.id, { characterCardOnly: true, includeCharacterCard: true, includePersona: true, includeWorldInfo: true, includeSystemPrompt: true, includeAuthorsNote: true, includeSummary: true, includeHiddenMessages: true, swipeContextMode: 'both' });
    addMessage(thread.id, 'user', 'Earlier diagnostic question');
    addMessage(thread.id, 'assistant', 'Earlier diagnostic answer');
    const storyThread = createThread('Story');
    addMessage(storyThread.id, 'user', 'PRIVATE_OTHER_THREAD');
    getSettings(); // Normal extension initialization fills defaults before a preview.
    const before = JSON.stringify(h.context);
    const preview = await buildPromptPreview(thread.id, 'Why is context full?');
    assert.equal(JSON.stringify(h.context), before, 'preview is read-only');
    assert.equal(h.requests.length, 0);
    assert.ok(preview.messages[0].content.startsWith(DEBUG_SYSTEM_PROMPT));
    assert.match(JSON.stringify(preview.messages), /Earlier diagnostic answer/);
    assert.doesNotMatch(JSON.stringify(preview.messages), /PRIVATE_|ROLEPLAY CHAT HISTORY|CHANGES SINCE/);
    const result = await generateScratchPadResponse('Why is context full?', thread.id);
    assert.equal(result.success, true, result.error);
    assert.doesNotMatch(JSON.stringify(h.requests[0]), /PRIVATE_/);
    assert.equal(regexMock.calls.length, 0);
    assert.equal(thread.messages.at(-1).extra.promptStats.chatMessages, 0);
    assert.equal(thread.messages.at(-1).extra.contextSnapshotKey, undefined);
    assert.equal(h.context.chatMetadata.scratchPad.contextSnapshots, undefined);
});

test('follow-ups, edits, retries, and swipes after reload use fresh configuration and keep debug mode', async () => {
    const h = harness();
    const thread = h.thread();
    assert.equal((await generateScratchPadResponse('First check', thread.id)).success, true);
    h.context.chatMetadata = structuredClone(h.context.chatMetadata);
    h.context.chatCompletionSettings.temp_openai = 0.2;
    assert.equal((await generateScratchPadResponse('Check again', thread.id)).success, true);
    assert.equal(snapshotFrom(h.requests.at(-1)).mainConnection.generation.temp_openai, 0.2);
    const saved = getThread(thread.id);
    h.context.chatCompletionSettings.temp_openai = 0.3;
    assert.equal((await generateSwipe(thread.id, saved.messages.at(-1).id)).success, true);
    assert.equal(snapshotFrom(h.requests.at(-1)).mainConnection.generation.temp_openai, 0.3);
    assert.equal((await editUserMessageAndRegenerate(thread.id, saved.messages[2].id, 'Edited diagnostic question')).success, true);
    saved.messages.at(-1).status = 'failed';
    assert.equal((await retryMessage(thread.id, saved.messages.at(-1).id)).success, true);
    assert.ok(isDebugThread(getThread(thread.id)));
    assert.doesNotMatch(JSON.stringify(h.requests), /PRIVATE_/);
});

test('mode survives branching and export/import; ordinary and legacy threads stay story threads', () => {
    const h = harness();
    const debug = h.thread();
    const reply = addMessage(debug.id, 'assistant', 'Diagnostic result');
    updateThread(debug.id, { name: 'Renamed', mode: 'story' });
    assert.ok(isDebugThread(debug), 'generic thread updates cannot convert the mode');
    assert.ok(isDebugThread(forkThread(debug.id, reply.id)));
    const [imported] = parseThreadImport(threadsToJson([debug]), () => Math.random().toString());
    assert.ok(isDebugThread(imported));
    assert.match(threadToMarkdown(debug), /Mode: Troubleshooting/);
    assert.equal(isDebugThread(createThread()), false);
    assert.equal(isDebugThread({}), false);
    assert.equal(isDebugThread({ contextSettings: { mode: 'debug' } }), false);
});

test('diagnostics stop before sending if the snapshot cannot fit', async () => {
    const h = harness();
    const thread = h.thread();
    h.context.chatCompletionSettings.openai_max_context = 900;
    h.context.chatCompletionSettings.openai_max_tokens = 800;
    const result = await generateScratchPadResponse('Check configuration', thread.id);
    assert.equal(result.success, false);
    assert.match(result.error, /snapshot.*exceed/);
    assert.equal(h.requests.length, 0);
});

test('text fallback disables character instruct formatting and does not expand diagnostic macros', async () => {
    const h = harness({ mainApi: 'textgenerationwebui', textCompletionSettings: { type: 'ooba', amount_gen: 800 } });
    const result = await generateScratchPadResponse('Explain {{char}} and {{setvar::x::1}} literally', h.thread().id);
    assert.equal(result.success, true, result.error);
    assert.equal(h.requests[0].instructOverride, true);
    assert.equal(h.requests[0].trimNames, false);
    assert.equal(h.requests[0].prompt[0].role, 'system');
    assert.doesNotMatch(JSON.stringify(h.requests), /PRIVATE_|\{\{/);
});

test('failed direct diagnostics never fall back to the standard story-capable pipeline', async () => {
    const h = harness({ sendGenerationRequest: async () => { throw new Error('fixture unavailable'); } });
    const result = await generateScratchPadResponse('Check settings', h.thread().id);
    assert.equal(result.success, false);
    assert.equal(h.requests.length, 0);
});

test('Connection Manager uses the selected preset without character instruct injection', async () => {
    const calls = [];
    const h = harness({
        CONNECT_API_MAP: { openai: { selected: 'openai' } },
        extensionSettings: { disabledExtensions: [], connectionManager: { profiles: [{ id: 'diagnostic-profile', name: 'Diagnostics', api: 'openai', model: 'diagnostic-model', preset: 'Test preset' }] }, scratchPad: { useAlternativeApi: true, connectionProfileId: 'diagnostic-profile' } },
        getPresetManager: () => ({ getCompletionPresetByName: () => ({ temperature: 0.1, openai_max_context: 16000, openai_max_tokens: 1000, custom_include_headers: 'PRIVATE_PRESET_SECRET' }) }),
        ConnectionManagerRequestService: { sendRequest: async (...args) => { calls.push(args); return { content: 'Profile diagnostic answer' }; } },
    });
    const result = await generateScratchPadResponse('Check my model', h.thread().id);
    assert.equal(result.success, true, result.error);
    assert.equal(calls[0][0], 'diagnostic-profile');
    assert.equal(calls[0][3].includeInstruct, false);
    assert.equal(calls[0][3].includePreset, true);
    assert.doesNotMatch(JSON.stringify(calls[0][1]), /PRIVATE_/);
    assert.equal(snapshotFrom(calls[0][1]).troubleshootingConnection.presetGeneration.temp_openai, 0.1);
});

test('/sp-debug has distinct empty, popup, quiet, and inactive-chat behavior; /sp stays story', async () => {
    const h = harness();
    const registered = new Map();
    const calls = [];
    let active = true;
    const fromProps = props => props;
    const context = vm.createContext({
        SillyTavern: { getContext: () => ({ SlashCommandParser: { addCommandObject: command => registered.set(command.name, command) }, SlashCommand: { fromProps }, SlashCommandArgument: { fromProps }, SlashCommandNamedArgument: { fromProps }, ARGUMENT_TYPE: { BOOLEAN: 'boolean', STRING: 'string' } }) },
        THREAD_MODE, createThread, saveMetadata: async () => {}, getCurrentContextSettings: () => ({}),
        isChatActive: () => active, openScratchPad: id => calls.push(['open', id]),
        showQuickPopup: message => calls.push(['story', message]),
        showQuickPopupDebug: message => calls.push(['debug', message]),
        askQuietly: (message, kind) => calls.push(['quiet', message, kind]),
        toastr: { warning: message => calls.push(['warning', message]) },
    });
    const source = fs.readFileSync(new URL('../src/commands.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context);
    context.registerCommands();
    const command = registered.get('sp-debug');
    assert.equal(command.unnamedArgumentList[0].isRequired, false);
    await command.callback({}, '');
    assert.ok(isDebugThread(getThread(calls.at(-1)[1])));
    await command.callback({}, 'Question');
    assert.deepEqual(calls.at(-1), ['debug', 'Question']);
    await command.callback({ quiet: 'true' }, 'Question');
    assert.deepEqual(calls.at(-1), ['quiet', 'Question', 'debug']);
    await registered.get('scratchpad').callback({}, 'Story question');
    assert.deepEqual(calls.at(-1), ['story', 'Story question']);
    active = false;
    const before = h.context.chatMetadata.scratchPad.threads.length;
    await command.callback({}, 'Question');
    assert.equal(calls.at(-1)[0], 'warning');
    assert.equal(h.context.chatMetadata.scratchPad.threads.length, before);
});
