/**
 * Settings module for Scratch Pad extension
 * Handles extension settings management
 */

import { dispatchConnectionProfilesChanged, getConnectionProfiles as getConnectionProfileList, renderConnectionProfileOptions, resolveConnectionProfileId } from './connectionProfiles.js';

const MODULE_NAME = 'scratchPad';

const DEFAULT_OOC_PROMPT = `You are a neutral observer and writing assistant helping the user understand and analyze their ongoing roleplay. Answer out-of-character questions about the story, characters, plot, or setting. Be direct, insightful, and helpful. Do not roleplay as any character — respond as an objective assistant.`;

const DEFAULT_SETTINGS = Object.freeze({
    chatHistoryLimit: 0, // 0 means use all available
    chatHistoryRangeMode: 'all',
    chatHistoryRangeStart: null,
    chatHistoryRangeEnd: null,
    includeCharacterCard: true,
    characterCardOnly: false,
    includeSystemPrompt: false,
    includeAuthorsNote: false,
    oocSystemPrompt: DEFAULT_OOC_PROMPT,
    useAlternativeApi: false,
    forceGlobalApiProfile: false,
    connectionProfileId: '',
    connectionProfile: '',
    textSize: 14, // Default text size in pixels
    ttsEnabled: false, // Enable TTS for assistant messages
    ttsVoice: '', // Voice name for TTS (from SillyTavern voice map)
    soundOnComplete: false, // Play notification sound when generation finishes
    displayMode: 'drawer', // Display mode: 'drawer' (overlay), 'pinned' (sidebar), 'fullscreen'
    useMultiMessageFormat: false, // Send structured multi-message array instead of concatenated prompt
    useStandardGeneration: false // Use ST's generateRaw helper for compatibility mode
});

/**
 * Get or initialize extension settings
 * @returns {Object} Extension settings
 */
export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    // Migrate pinnedMode → displayMode for existing users (must run before defaults fill)
    if (Object.hasOwn(extensionSettings[MODULE_NAME], 'pinnedMode')) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], 'displayMode')) {
            extensionSettings[MODULE_NAME].displayMode = extensionSettings[MODULE_NAME].pinnedMode ? 'pinned' : 'drawer';
        }
        delete extensionSettings[MODULE_NAME].pinnedMode;
    }

    // Ensure all default keys exist
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }

    migrateConnectionProfileSetting(extensionSettings[MODULE_NAME]);

    return extensionSettings[MODULE_NAME];
}

function migrateConnectionProfileSetting(settings) {
    if (settings.connectionProfileId || !settings.connectionProfile) return;

    const migratedId = resolveConnectionProfileId(settings.connectionProfile);
    if (migratedId) {
        settings.connectionProfileId = migratedId;
        settings.connectionProfile = '';
    }
}

/**
 * Update extension settings
 * @param {Object} updates Settings to update
 */
export function updateSettings(updates) {
    const settings = getSettings();
    const normalizedUpdates = { ...updates };

    if (Object.hasOwn(normalizedUpdates, 'connectionProfile') && !Object.hasOwn(normalizedUpdates, 'connectionProfileId')) {
        normalizedUpdates.connectionProfileId = normalizedUpdates.connectionProfile
            ? (resolveConnectionProfileId(normalizedUpdates.connectionProfile) || normalizedUpdates.connectionProfile)
            : '';
        normalizedUpdates.connectionProfile = '';
    }

    Object.assign(settings, normalizedUpdates);

    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

/**
 * Reset OOC prompt to default
 */
export function resetOocPrompt() {
    updateSettings({ oocSystemPrompt: DEFAULT_OOC_PROMPT });
}

/**
 * Get the default OOC prompt
 * @returns {string} Default OOC prompt
 */
export function getDefaultOocPrompt() {
    return DEFAULT_OOC_PROMPT;
}

/**
 * Get the current display mode
 * @returns {'drawer'|'pinned'|'fullscreen'} Display mode
 */
export function getDisplayMode() {
    return getSettings().displayMode || 'drawer';
}

export function isGlobalApiProfileForced() {
    const settings = getSettings();
    return !!(settings.useAlternativeApi && settings.forceGlobalApiProfile);
}

/**
 * Set the display mode
 * @param {'drawer'|'pinned'|'fullscreen'} mode Display mode
 */
export function setDisplayMode(mode) {
    updateSettings({ displayMode: mode });
}

/**
 * Load settings into the UI
 */
export function loadSettingsUI() {
    const settings = getSettings();

    // Chat history limit slider
    const historySlider = document.getElementById('sp_chat_history_limit');
    const historyValue = document.getElementById('sp_chat_history_limit_value');
    if (historySlider && historyValue) {
        historySlider.value = settings.chatHistoryLimit;
        historyValue.textContent = settings.chatHistoryLimit === 0 ? 'All' : settings.chatHistoryLimit;
    }

    // Chat history range controls
    const rangeModeSelect = document.getElementById('sp_chat_history_range_mode');
    const rangeStartInput = document.getElementById('sp_chat_history_range_start');
    const rangeEndInput = document.getElementById('sp_chat_history_range_end');
    if (rangeModeSelect) {
        rangeModeSelect.value = settings.chatHistoryRangeMode || 'all';
    }
    if (rangeStartInput) {
        rangeStartInput.value = settings.chatHistoryRangeStart ?? '';
    }
    if (rangeEndInput) {
        rangeEndInput.value = settings.chatHistoryRangeEnd ?? '';
    }
    updateRangeInputsVisibility();

    // Include character card toggle
    const charCardToggle = document.getElementById('sp_include_char_card');
    if (charCardToggle) {
        charCardToggle.checked = settings.includeCharacterCard;
    }

    const charCardOnlyToggle = document.getElementById('sp_char_card_only');
    if (charCardOnlyToggle) {
        charCardOnlyToggle.checked = settings.characterCardOnly;
    }

    // Include system prompt toggle
    const sysPromptToggle = document.getElementById('sp_include_sys_prompt');
    if (sysPromptToggle) {
        sysPromptToggle.checked = settings.includeSystemPrompt;
    }

    // Include author's note toggle
    const authorsNoteToggle = document.getElementById('sp_include_authors_note');
    if (authorsNoteToggle) {
        authorsNoteToggle.checked = settings.includeAuthorsNote;
    }

    // OOC system prompt textarea
    const oocPromptTextarea = document.getElementById('sp_ooc_prompt');
    if (oocPromptTextarea) {
        oocPromptTextarea.value = settings.oocSystemPrompt;
    }

    // Use alternative API toggle
    const altApiToggle = document.getElementById('sp_use_alt_api');
    if (altApiToggle) {
        altApiToggle.checked = settings.useAlternativeApi;
    }

    // Connection profile dropdown visibility
    const profileContainer = document.getElementById('sp_profile_container');
    if (profileContainer) {
        profileContainer.style.display = settings.useAlternativeApi ? 'block' : 'none';
    }

    const forceGlobalApiToggle = document.getElementById('sp_force_global_api_profile');
    if (forceGlobalApiToggle) {
        forceGlobalApiToggle.checked = settings.forceGlobalApiProfile;
    }

    // Connection profile dropdown
    const profileSelect = document.getElementById('sp_connection_profile');
    if (profileSelect) {
        profileSelect.value = settings.connectionProfileId || settings.connectionProfile || '';
    }

    // Text size slider
    const textSizeSlider = document.getElementById('sp_text_size');
    const textSizeValue = document.getElementById('sp_text_size_value');
    if (textSizeSlider && textSizeValue) {
        textSizeSlider.value = settings.textSize;
        textSizeValue.textContent = `${settings.textSize}px`;
    }

    // Apply text size to the UI
    applyTextSize(settings.textSize);

    // TTS enabled toggle
    const ttsEnabledToggle = document.getElementById('sp_tts_enabled');
    if (ttsEnabledToggle) {
        ttsEnabledToggle.checked = settings.ttsEnabled;
    }

    // TTS voice input
    const ttsVoiceInput = document.getElementById('sp_tts_voice');
    if (ttsVoiceInput) {
        ttsVoiceInput.value = settings.ttsVoice || '';
    }

    // TTS voice container visibility
    const ttsVoiceContainer = document.getElementById('sp_tts_voice_container');
    if (ttsVoiceContainer) {
        ttsVoiceContainer.style.display = settings.ttsEnabled ? 'block' : 'none';
    }

    // Sound on completion toggle
    const soundToggle = document.getElementById('sp_sound_on_complete');
    if (soundToggle) {
        soundToggle.checked = settings.soundOnComplete;
    }

    // Display mode select
    const displayModeSelect = document.getElementById('sp_display_mode');
    if (displayModeSelect) {
        displayModeSelect.value = settings.displayMode || 'drawer';
    }

    // Multi-message format toggle
    const multiMsgToggle = document.getElementById('sp_multi_message_format');
    if (multiMsgToggle) {
        multiMsgToggle.checked = settings.useMultiMessageFormat;
    }

    // Standard generation toggle
    const stdGenToggle = document.getElementById('sp_standard_generation');
    if (stdGenToggle) {
        stdGenToggle.checked = settings.useStandardGeneration;
    }
}

/**
 * Initialize settings event listeners
 */
export function initSettingsListeners() {
    initConnectionProfileChangeListeners();

    // Chat history limit slider
    const historySlider = document.getElementById('sp_chat_history_limit');
    const historyValue = document.getElementById('sp_chat_history_limit_value');
    if (historySlider) {
        bindOnce(historySlider, 'input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (historyValue) {
                historyValue.textContent = value === 0 ? 'All' : value;
            }
            updateSettings({ chatHistoryLimit: value });
        });
    }

    // Chat history range mode
    const rangeModeSelect = document.getElementById('sp_chat_history_range_mode');
    const rangeStartInput = document.getElementById('sp_chat_history_range_start');
    const rangeEndInput = document.getElementById('sp_chat_history_range_end');
    if (rangeModeSelect) {
        bindOnce(rangeModeSelect, 'change', (e) => {
            updateSettings({ chatHistoryRangeMode: e.target.value });
            updateRangeInputsVisibility();
        });
    }

    if (rangeStartInput) {
        bindOnce(rangeStartInput, 'input', (e) => {
            updateSettings({ chatHistoryRangeStart: parseRangeNumber(e.target.value) });
        });
    }

    if (rangeEndInput) {
        bindOnce(rangeEndInput, 'input', (e) => {
            updateSettings({ chatHistoryRangeEnd: parseRangeNumber(e.target.value) });
        });
    }

    // Include character card toggle
    const charCardToggle = document.getElementById('sp_include_char_card');
    if (charCardToggle) {
        bindOnce(charCardToggle, 'change', (e) => {
            updateSettings({ includeCharacterCard: e.target.checked });
        });
    }

    const charCardOnlyToggle = document.getElementById('sp_char_card_only');
    if (charCardOnlyToggle) {
        bindOnce(charCardOnlyToggle, 'change', (e) => {
            const enabled = e.target.checked;
            updateSettings({ characterCardOnly: enabled, includeCharacterCard: enabled ? true : getSettings().includeCharacterCard });
            if (enabled && charCardToggle) {
                charCardToggle.checked = true;
            }
        });
    }

    // Include system prompt toggle
    const sysPromptToggle = document.getElementById('sp_include_sys_prompt');
    if (sysPromptToggle) {
        bindOnce(sysPromptToggle, 'change', (e) => {
            updateSettings({ includeSystemPrompt: e.target.checked });
        });
    }

    // Include author's note toggle
    const authorsNoteToggle = document.getElementById('sp_include_authors_note');
    if (authorsNoteToggle) {
        bindOnce(authorsNoteToggle, 'change', (e) => {
            updateSettings({ includeAuthorsNote: e.target.checked });
        });
    }

    // OOC system prompt textarea
    const oocPromptTextarea = document.getElementById('sp_ooc_prompt');
    if (oocPromptTextarea) {
        bindOnce(oocPromptTextarea, 'input', (e) => {
            updateSettings({ oocSystemPrompt: e.target.value });
        });
    }

    // Reset OOC prompt button
    const resetButton = document.getElementById('sp_reset_ooc_prompt');
    if (resetButton) {
        bindOnce(resetButton, 'click', () => {
            resetOocPrompt();
            if (oocPromptTextarea) {
                oocPromptTextarea.value = DEFAULT_OOC_PROMPT;
            }
        });
    }

    // Use alternative API toggle
    const altApiToggle = document.getElementById('sp_use_alt_api');
    const profileContainer = document.getElementById('sp_profile_container');
    if (altApiToggle) {
        bindOnce(altApiToggle, 'change', (e) => {
            updateSettings({ useAlternativeApi: e.target.checked });
            if (profileContainer) {
                profileContainer.style.display = e.target.checked ? 'block' : 'none';
            }
            dispatchConnectionProfilesChanged();
        });
    }

    const forceGlobalApiToggle = document.getElementById('sp_force_global_api_profile');
    if (forceGlobalApiToggle) {
        bindOnce(forceGlobalApiToggle, 'change', (e) => {
            updateSettings({ forceGlobalApiProfile: e.target.checked });
            dispatchConnectionProfilesChanged();
        });
    }

    // Connection profile dropdown
    const profileSelect = document.getElementById('sp_connection_profile');
    if (profileSelect) {
        bindOnce(profileSelect, 'change', (e) => {
            updateSettings({ connectionProfileId: e.target.value, connectionProfile: '' });
        });
    }

    // Text size slider
    const textSizeSlider = document.getElementById('sp_text_size');
    const textSizeValue = document.getElementById('sp_text_size_value');
    if (textSizeSlider) {
        bindOnce(textSizeSlider, 'input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (textSizeValue) {
                textSizeValue.textContent = `${value}px`;
            }
            updateSettings({ textSize: value });
            applyTextSize(value);
        });
    }

    // TTS enabled toggle
    const ttsEnabledToggle = document.getElementById('sp_tts_enabled');
    const ttsVoiceContainer = document.getElementById('sp_tts_voice_container');
    if (ttsEnabledToggle) {
        bindOnce(ttsEnabledToggle, 'change', (e) => {
            updateSettings({ ttsEnabled: e.target.checked });
            if (ttsVoiceContainer) {
                ttsVoiceContainer.style.display = e.target.checked ? 'block' : 'none';
            }
        });
    }

    // TTS voice input
    const ttsVoiceInput = document.getElementById('sp_tts_voice');
    if (ttsVoiceInput) {
        bindOnce(ttsVoiceInput, 'input', (e) => {
            updateSettings({ ttsVoice: e.target.value.trim() });
        });
    }

    // Sound on completion toggle
    const soundToggle = document.getElementById('sp_sound_on_complete');
    if (soundToggle) {
        bindOnce(soundToggle, 'change', (e) => {
            updateSettings({ soundOnComplete: e.target.checked });
        });
    }

    // Display mode select
    const displayModeSelect = document.getElementById('sp_display_mode');
    if (displayModeSelect) {
        bindOnce(displayModeSelect, 'change', (e) => {
            updateSettings({ displayMode: e.target.value });
        });
    }

    // Multi-message format toggle
    const multiMsgToggle = document.getElementById('sp_multi_message_format');
    if (multiMsgToggle) {
        bindOnce(multiMsgToggle, 'change', (e) => {
            updateSettings({ useMultiMessageFormat: e.target.checked });
        });
    }

    // Standard generation toggle
    const stdGenToggle = document.getElementById('sp_standard_generation');
    if (stdGenToggle) {
        bindOnce(stdGenToggle, 'change', (e) => {
            updateSettings({ useStandardGeneration: e.target.checked });
        });
    }
}

let connectionProfileListenersInitialized = false;

function initConnectionProfileChangeListeners() {
    if (connectionProfileListenersInitialized) return;

    const context = SillyTavern.getContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes || {};
    if (!eventSource?.on) return;

    const refreshProfiles = () => {
        populateConnectionProfiles();
        dispatchConnectionProfilesChanged();
    };

    [
        eventTypes.CONNECTION_PROFILE_CREATED,
        eventTypes.CONNECTION_PROFILE_UPDATED,
        eventTypes.CONNECTION_PROFILE_DELETED,
    ].filter(Boolean).forEach(eventName => eventSource.on(eventName, refreshProfiles));

    connectionProfileListenersInitialized = true;
}

function bindOnce(element, eventName, handler) {
    if (!element) return;
    const key = `spBound${eventName.charAt(0).toUpperCase()}${eventName.slice(1)}`;
    if (element.dataset[key]) return;
    element.addEventListener(eventName, handler);
    element.dataset[key] = 'true';
}

function updateRangeInputsVisibility() {
    const rangeModeSelect = document.getElementById('sp_chat_history_range_mode');
    const rangeInputs = document.getElementById('sp_chat_history_range_inputs');
    if (!rangeModeSelect || !rangeInputs) return;

    rangeInputs.style.display = rangeModeSelect.value === 'all' ? 'none' : 'flex';
}

function parseRangeNumber(value) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return null;
    return parsed;
}

/**
 * Apply text size to the Scratch Pad UI
 * @param {number} size Text size in pixels
 */
export function applyTextSize(size) {
    document.documentElement.style.setProperty('--sp-text-size', `${size}px`);
}

/**
 * Get current context settings from global settings
 * Used when creating new threads to copy current global context settings
 * @returns {Object} Context settings object
 */
export function getCurrentContextSettings() {
    const settings = getSettings();
    const profileId = settings.useAlternativeApi
        ? resolveConnectionProfileId(settings.connectionProfileId || settings.connectionProfile)
        : null;

    return {
        chatHistoryRangeMode: settings.chatHistoryRangeMode,
        chatHistoryRangeStart: settings.chatHistoryRangeStart,
        chatHistoryRangeEnd: settings.chatHistoryRangeEnd,
        characterCardOnly: settings.characterCardOnly,
        includeCharacterCard: settings.includeCharacterCard,
        includeSystemPrompt: settings.includeSystemPrompt,
        includeAuthorsNote: settings.includeAuthorsNote,
        connectionProfileId: profileId,
        connectionProfile: null
    };
}

/**
 * Populate connection profiles dropdown
 */
export async function populateConnectionProfiles() {
    const profileSelect = document.getElementById('sp_connection_profile');
    if (!profileSelect) return;

    const settings = getSettings();
    const result = renderConnectionProfileOptions(profileSelect, settings.connectionProfileId || settings.connectionProfile);

    if (result.selectedId && settings.connectionProfileId !== result.selectedId) {
        updateSettings({ connectionProfileId: result.selectedId, connectionProfile: '' });
    }
}

/**
 * Get list of connection profiles from SillyTavern
 * @returns {Promise<Array>} Array of supported profile objects
 */
export async function getConnectionProfiles() {
    return getConnectionProfileList();
}
