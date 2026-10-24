import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getSettings, initSettingsListeners, loadSettingsUI, populateConnectionProfiles, updateSettings } from '../src/settings.js';
import { getStoredEmbeddingSettings } from '../src/embeddings.js';

const html = fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

class Element extends EventTarget {
    constructor() {
        super();
        this.dataset = {};
        this.style = {};
        this.children = [];
        this.value = '';
        this.checked = false;
        this.textContent = '';
        this.hidden = false;
        this.disabled = false;
    }
    appendChild(child) { this.children.push(child); }
    set innerHTML(value) { this.children = []; this.html = value; }
    querySelectorAll() { return this.children; }
    fire(type, properties = {}) { Object.assign(this, properties); this.dispatchEvent(new Event(type)); }
}

function harness(t, { shared = false } = {}) {
    const original = { document: globalThis.document, window: globalThis.window, SillyTavern: globalThis.SillyTavern };
    t.after(() => Object.assign(globalThis, original));
    const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => {
        const element = new Element();
        element.hidden = /\shidden(?:\s|>)/.test(match[0]);
        return [match[1], element];
    }));
    const element = id => elements.get(id);
    element('sp_emb_config').children = ['sp_emb_provider', 'sp_emb_api_key', 'sp_emb_ollama_url', 'sp_emb_model'].map(element);
    globalThis.document = {
        getElementById: id => element(id) || null,
        createElement: () => new Element(),
        documentElement: { style: { setProperty() {} } },
    };
    globalThis.window = new EventTarget();
    let saves = 0;
    const context = {
        extensionSettings: {
            connectionManager: { profiles: [{ id: 'profile-1', name: 'Writing profile', api: 'openai' }] },
            ...(shared ? { chat_manager: { embeddings: { provider: 'openai', model: 'shared-model', apiKey: 'shared-secret' } } } : {}),
        },
        chatMetadata: { scratchPad: { threads: [{ id: 'saved-thread', contextSettings: { includePersona: false } }] } },
        ConnectionManagerRequestService: { isProfileSupported: () => true },
        saveSettingsDebounced: () => { saves++; },
    };
    globalThis.SillyTavern = { getContext: () => context };
    const settings = getSettings();
    Object.assign(settings, {
        displayMode: 'pinned', textSize: 18, soundOnComplete: true,
        chatHistoryLimit: 170, chatHistoryRangeMode: 'between', chatHistoryRangeStart: 12, chatHistoryRangeEnd: 82,
        swipeContextMode: 'both', includeWorldInfo: true, includeAuthorsNote: true,
        quickPrompts: ['A saved question', 'Another saved question'], oocSystemPrompt: 'My custom instructions.\nKeep this exact text.',
        ttsEnabled: true, ttsAutoGenerate: true, ttsVoice: 'Narrator',
        useAlternativeApi: true, connectionProfileId: 'profile-1', forceGlobalApiProfile: true,
        useMultiMessageFormat: true, useStandardGeneration: true, futureSetting: { keep: 'untouched' },
    });
    Object.assign(getStoredEmbeddingSettings(), {
        enabled: true, useSharedConfig: shared, provider: 'ollama', model: 'saved-local-model',
        apiKey: 'saved-local-secret', ollamaUrl: 'http://saved-local-host:11434', dimensions: 768,
    });
    saves = 0;
    return { context, settings, element, elements, saves: () => saves };
}

test('loading the reorganized settings preserves every saved value and existing thread settings', t => {
    const h = harness(t);
    const savedSettings = structuredClone(h.context.extensionSettings);
    const savedThreads = structuredClone(h.context.chatMetadata);
    loadSettingsUI();
    initSettingsListeners();
    assert.deepEqual(h.context.extensionSettings, savedSettings);
    assert.deepEqual(h.context.chatMetadata, savedThreads);
    assert.equal(h.saves(), 0, 'opening settings must not rewrite saved values');
    for (const [id, value] of Object.entries({
        sp_text_size: 18, sp_display_mode: 'pinned', sp_chat_history_limit: 170, sp_swipe_context_mode: 'both',
        sp_quick_prompts: 'A saved question\nAnother saved question', sp_ooc_prompt: h.settings.oocSystemPrompt,
        sp_tts_voice: 'Narrator', sp_connection_profile: 'profile-1', sp_emb_provider: 'ollama',
        sp_emb_model: 'saved-local-model', sp_emb_api_key: 'saved-local-secret', sp_emb_ollama_url: 'http://saved-local-host:11434',
    })) assert.equal(h.element(id).value, value, id);
    for (const id of ['sp_sound_on_complete', 'sp_include_char_card', 'sp_include_authors_note', 'sp_include_persona', 'sp_include_world_info', 'sp_tts_enabled', 'sp_tts_auto_generate', 'sp_use_alt_api', 'sp_force_global_api_profile', 'sp_multi_message_format', 'sp_standard_generation', 'sp_emb_enabled']) {
        assert.equal(h.element(id).checked, true, id);
    }
});

test('collapsed summaries reflect saved settings and update when controls change', t => {
    const h = harness(t);
    loadSettingsUI();
    initSettingsListeners();
    assert.equal(h.element('sp_settings_general_summary').textContent, 'Pinned sidebar · 18px · Sound on');
    assert.match(h.element('sp_settings_context_summary').textContent, /History 12–82.*4 sources.*User \+ AI swipes/);
    assert.equal(h.element('sp_settings_prompts_summary').textContent, '2 quick prompts · Custom instructions');
    assert.equal(h.element('sp_settings_voice_summary').textContent, 'Automatic · Narrator');
    assert.equal(h.element('sp_settings_search_summary').textContent, 'Semantic · Ollama · saved-local-model');
    assert.equal(h.element('sp_settings_connection_summary').textContent, 'Writing profile · All threads');
    assert.equal(h.element('sp_settings_advanced_summary').textContent, 'Multi-message format · Standard generation');
    h.element('sp_display_mode').fire('change', { value: 'fullscreen' });
    assert.match(h.element('sp_settings_general_summary').textContent, /^Fullscreen/);
    h.element('sp_tts_auto_generate').fire('change', { checked: false });
    assert.equal(h.element('sp_settings_voice_summary').textContent, 'Manual · Narrator');
    updateSettings({ characterCardOnly: true });
    assert.equal(h.element('sp_settings_context_summary').textContent, 'Character card only');
    const headers = [...h.elements].filter(([id]) => id.startsWith('sp_settings_')).map(([, value]) => value.textContent).join('\n');
    assert.doesNotMatch(headers, /saved-local-secret|shared-secret|http:\/\/saved-local-host|My custom instructions/);
});

test('hiding Voice and Connection options retains their configuration', t => {
    const h = harness(t);
    loadSettingsUI();
    initSettingsListeners();
    const before = structuredClone(h.settings);
    h.element('sp_tts_enabled').fire('change', { checked: false });
    h.element('sp_use_alt_api').fire('change', { checked: false });
    assert.equal(h.element('sp_tts_voice_container').hidden, true);
    assert.equal(h.element('sp_profile_container').hidden, true);
    assert.equal(h.element('sp_settings_voice_summary').textContent, 'Off');
    assert.equal(h.element('sp_settings_connection_summary').textContent, 'Current SillyTavern profile');
    h.element('sp_tts_enabled').fire('change', { checked: true });
    h.element('sp_use_alt_api').fire('change', { checked: true });
    assert.equal(h.element('sp_tts_voice_container').hidden, false);
    assert.equal(h.element('sp_profile_container').hidden, false);
    assert.deepEqual(h.settings, before);
});

test('semantic search hides inactive or shared configuration and restores local values', t => {
    const h = harness(t, { shared: true });
    loadSettingsUI();
    initSettingsListeners();
    const before = structuredClone(h.settings.embeddings);
    assert.equal(h.element('sp_emb_config').hidden, true);
    assert.equal(h.element('sp_emb_api_key').disabled, true);
    assert.match(h.element('sp_settings_search_summary').textContent, /Chat Manager · shared-model/);
    h.element('sp_emb_enabled').fire('change', { checked: false });
    assert.equal(h.element('sp_emb_options').hidden, true);
    assert.equal(h.element('sp_settings_search_summary').textContent, 'Keyword search only');
    h.element('sp_emb_enabled').fire('change', { checked: true });
    h.element('sp_emb_use_shared').fire('change', { checked: false });
    assert.equal(h.element('sp_emb_options').hidden, false);
    assert.equal(h.element('sp_emb_config').hidden, false);
    assert.equal(h.element('sp_emb_api_key').disabled, false);
    assert.equal(h.element('sp_emb_api_key_wrap').hidden, true);
    assert.equal(h.element('sp_emb_ollama_wrap').hidden, false);
    assert.equal(h.element('sp_emb_model').value, 'saved-local-model');
    h.element('sp_emb_provider').fire('change', { value: 'openai' });
    assert.equal(h.element('sp_emb_api_key_wrap').hidden, false);
    assert.equal(h.element('sp_emb_ollama_wrap').hidden, true);
    assert.equal(h.element('sp_emb_api_key').value, 'saved-local-secret');
    h.element('sp_emb_provider').fire('change', { value: 'ollama' });
    h.element('sp_emb_use_shared').fire('change', { checked: true });
    assert.deepEqual(h.settings.embeddings, before);
});

test('sharing without Chat Manager keeps the existing local fallback editable', t => {
    const h = harness(t);
    h.settings.embeddings.useSharedConfig = true;
    loadSettingsUI();
    assert.equal(h.element('sp_emb_config').hidden, false);
    assert.equal(h.element('sp_emb_api_key').disabled, false);
    assert.match(h.element('sp_emb_shared_notice').textContent, /local settings below are used/);
    assert.match(h.element('sp_settings_search_summary').textContent, /Ollama · saved-local-model/);
});

test('profile renames refresh the summary while preserving the saved profile ID', async t => {
    const h = harness(t);
    loadSettingsUI();
    h.context.extensionSettings.connectionManager.profiles[0].name = 'Renamed profile';
    await populateConnectionProfiles();
    assert.equal(h.settings.connectionProfileId, 'profile-1');
    assert.equal(h.element('sp_settings_connection_summary').textContent, 'Renamed profile · All threads');
    assert.equal(h.saves(), 0);
});

test('reinitializing listeners does not double-save a change or reset hidden values', t => {
    const h = harness(t);
    loadSettingsUI();
    initSettingsListeners();
    initSettingsListeners();
    h.element('sp_tts_enabled').fire('change', { checked: false });
    assert.equal(h.saves(), 1);
    assert.equal(h.settings.ttsVoice, 'Narrator');
    assert.equal(h.settings.ttsAutoGenerate, true);
});
