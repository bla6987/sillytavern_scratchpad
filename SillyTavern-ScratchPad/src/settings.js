/**
 * Settings module for Scratch Pad extension
 * Handles extension settings management
 */

const MODULE_NAME = 'scratchPad';

const DEFAULT_OOC_PROMPT = `You are a neutral observer and writing assistant helping the user understand and analyze their ongoing roleplay. Answer out-of-character questions about the story, characters, plot, or setting. Be direct, insightful, and helpful. Do not roleplay as any character — respond as an objective assistant.

At the very beginning of your first response in a new conversation, provide a brief title (3-6 words) for this discussion on its own line, formatted as: **Title: [Your Title Here]**

Then provide your response.`;

const DEFAULT_SETTINGS = Object.freeze({
    chatHistoryLimit: 0, // 0 means use all available
    includeCharacterCard: true,
    includeSystemPrompt: false,
    oocSystemPrompt: DEFAULT_OOC_PROMPT,
    useAlternativeApi: false,
    connectionProfile: ''
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
    
    // Include character card toggle
    const charCardToggle = document.getElementById('sp_include_char_card');
    if (charCardToggle) {
        charCardToggle.checked = settings.includeCharacterCard;
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
}

/**
 * Initialize settings event listeners
 */
export function initSettingsListeners() {
    // Chat history limit slider
    const historySlider = document.getElementById('sp_chat_history_limit');
    const historyValue = document.getElementById('sp_chat_history_limit_value');
    if (historySlider) {
        historySlider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (historyValue) {
                historyValue.textContent = value === 0 ? 'All' : value;
            }
            updateSettings({ chatHistoryLimit: value });
        });
    }
    
    // Include character card toggle
    const charCardToggle = document.getElementById('sp_include_char_card');
    if (charCardToggle) {
        charCardToggle.addEventListener('change', (e) => {
            updateSettings({ includeCharacterCard: e.target.checked });
        });
    }
    
    // Include system prompt toggle
    const sysPromptToggle = document.getElementById('sp_include_sys_prompt');
    if (sysPromptToggle) {
        sysPromptToggle.addEventListener('change', (e) => {
            updateSettings({ includeSystemPrompt: e.target.checked });
        });
    }
    
    // OOC system prompt textarea
    const oocPromptTextarea = document.getElementById('sp_ooc_prompt');
    if (oocPromptTextarea) {
        oocPromptTextarea.addEventListener('input', (e) => {
            updateSettings({ oocSystemPrompt: e.target.value });
        });
    }
    
    // Reset OOC prompt button
    const resetButton = document.getElementById('sp_reset_ooc_prompt');
    if (resetButton) {
        resetButton.addEventListener('click', () => {
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
        altApiToggle.addEventListener('change', (e) => {
            updateSettings({ useAlternativeApi: e.target.checked });
            if (profileContainer) {
                profileContainer.style.display = e.target.checked ? 'block' : 'none';
            }
        });
    }
    
    // Connection profile dropdown
    const profileSelect = document.getElementById('sp_connection_profile');
    if (profileSelect) {
        profileSelect.addEventListener('change', (e) => {
            updateSettings({ connectionProfile: e.target.value });
        });
    }
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
