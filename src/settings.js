/**
 * Settings module for Scratch Pad extension
 * Handles extension settings management
 */

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
    oocSystemPrompt: DEFAULT_OOC_PROMPT,
    useAlternativeApi: false,
    connectionProfile: '',
    textSize: 14, // Default text size in pixels
    ttsEnabled: false, // Enable TTS for assistant messages
    ttsVoice: '', // Voice name for TTS (from SillyTavern voice map)
    soundOnComplete: false, // Play notification sound when generation finishes
    pinnedMode: false, // Pin drawer to side instead of overlay (desktop only)
    useMultiMessageFormat: false, // Send structured multi-message array instead of concatenated prompt
    useStandardGeneration: false // Use ST's full generation pipeline (emergency compatibility mode)
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

    // Ensure all default keys exist
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }

    return extensionSettings[MODULE_NAME];
}

/**
 * Update extension settings
 * @param {Object} updates Settings to update
 */
export function updateSettings(updates) {
    const settings = getSettings();
    Object.assign(settings, updates);

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

    // Connection profile dropdown
    const profileSelect = document.getElementById('sp_connection_profile');
    if (profileSelect) {
        profileSelect.value = settings.connectionProfile;
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

    // Pinned mode toggle
    const pinnedModeToggle = document.getElementById('sp_pinned_mode');
    if (pinnedModeToggle) {
        pinnedModeToggle.checked = settings.pinnedMode;
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
        });
    }

    // Connection profile dropdown
    const profileSelect = document.getElementById('sp_connection_profile');
    if (profileSelect) {
        bindOnce(profileSelect, 'change', (e) => {
            updateSettings({ connectionProfile: e.target.value });
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

    // Pinned mode toggle
    const pinnedModeToggle = document.getElementById('sp_pinned_mode');
    if (pinnedModeToggle) {
        bindOnce(pinnedModeToggle, 'change', (e) => {
            updateSettings({ pinnedMode: e.target.checked });
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
    return {
        chatHistoryRangeMode: settings.chatHistoryRangeMode,
        chatHistoryRangeStart: settings.chatHistoryRangeStart,
        chatHistoryRangeEnd: settings.chatHistoryRangeEnd,
        characterCardOnly: settings.characterCardOnly,
        includeCharacterCard: settings.includeCharacterCard,
        includeSystemPrompt: settings.includeSystemPrompt,
        connectionProfile: settings.useAlternativeApi ? settings.connectionProfile : null
    };
}

/**
 * Populate connection profiles dropdown
 */
export async function populateConnectionProfiles() {
    const profileSelect = document.getElementById('sp_connection_profile');
    if (!profileSelect) return;

    try {
        // Try to get profiles via slash command
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        if (executeSlashCommandsWithOptions) {
            const result = await executeSlashCommandsWithOptions('/profile-list', { handleParserErrors: false, handleExecutionErrors: false });
            if (result && result.pipe) {
                const profiles = result.pipe.split(',').map(p => p.trim()).filter(p => p);

                profileSelect.innerHTML = '<option value="">-- Select Profile --</option>';
                profiles.forEach(profile => {
                    const option = document.createElement('option');
                    option.value = profile;
                    option.textContent = profile;
                    profileSelect.appendChild(option);
                });

                // Restore selected value
                const settings = getSettings();
                if (settings.connectionProfile) {
                    profileSelect.value = settings.connectionProfile;
                }
            }
        }
    } catch (error) {
        console.warn('[ScratchPad] Could not load connection profiles:', error);
    }
}

/**
 * Get list of connection profiles from SillyTavern
 * @returns {Promise<string[]>} Array of profile names
 */
export async function getConnectionProfiles() {
    try {
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        if (executeSlashCommandsWithOptions) {
            const result = await executeSlashCommandsWithOptions('/profile-list', { handleParserErrors: false, handleExecutionErrors: false });
            if (result && result.pipe) {
                return result.pipe.split(',').map(p => p.trim()).filter(p => p);
            }
        }
    } catch (error) {
        console.warn('[ScratchPad] Could not load connection profiles:', error);
    }
    return [];
}
