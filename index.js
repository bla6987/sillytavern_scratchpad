/**
 * Scratch Pad Extension for SillyTavern
 * Main entry point - initialization and event handlers
 */

import { ensureScratchPadExists } from './src/storage.js';
import { getSettings, loadSettingsUI, initSettingsListeners, populateConnectionProfiles } from './src/settings.js';
import { registerCommands, initPopupFunctions } from './src/commands.js';
import { isChatActive } from './src/generation.js';
import { initUI, openScratchPad, closeScratchPad, refreshScratchPadUI, isScratchPadOpen } from './src/ui/index.js';

const MODULE_NAME = 'scratchPad';
const EXTENSION_NAME = 'Scratch Pad';

function getLocalUrl(relativePath) {
    try {
        return new URL(relativePath, import.meta.url).toString();
    } catch (e) {
        return relativePath;
    }
}

async function fetchFirstOkText(urls) {
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (res.ok) return await res.text();
        } catch (e) {
            // ignore and try next
        }
    }
    return null;
}

function ensureStylesLoaded() {
    const styleId = 'scratch_pad_styles';
    const existing = document.getElementById(styleId);
    if (existing) return;

    const hrefCandidates = [
        getLocalUrl('./style.css'),
        '/scripts/extensions/third-party/sillytavern_scratchpad/style.css',
        '/extensions/third-party/sillytavern_scratchpad/style.css',
    ];

    const link = document.createElement('link');
    link.id = styleId;
    link.rel = 'stylesheet';

    let idx = 0;
    const tryNext = () => {
        if (idx >= hrefCandidates.length) return;
        link.href = hrefCandidates[idx++];
    };

    link.addEventListener('error', tryNext);
    tryNext();
    document.head.appendChild(link);
}

/**
 * Load the settings HTML template
 */
async function loadSettingsHTML() {
    const settingsContainer = document.getElementById('scratch_pad_settings');

    if (settingsContainer) {
        // Settings already loaded
        return;
    }

    try {
        const html = await fetchFirstOkText([
            getLocalUrl('./settings.html'),
            '/scripts/extensions/third-party/sillytavern_scratchpad/settings.html',
            '/extensions/third-party/sillytavern_scratchpad/settings.html',
        ]);

        if (html) {
            appendSettingsHTML(html);
        } else {
            console.warn('[ScratchPad] Failed to load settings HTML from any known path');
        }
    } catch (error) {
        console.error('[ScratchPad] Failed to load settings HTML:', error);
    }
}

/**
 * Append settings HTML to the extensions panel
 * @param {string} html Settings HTML content
 */
function appendSettingsHTML(html) {
    const extensionsSettings = document.getElementById('extensions_settings2');
    if (!extensionsSettings) {
        console.warn('[ScratchPad] Extensions settings container not found');
        return;
    }

    const settingsDiv = document.createElement('div');
    settingsDiv.id = 'scratch_pad_settings';
    settingsDiv.innerHTML = html;
    extensionsSettings.appendChild(settingsDiv);

    // Initialize settings UI
    loadSettingsUI();
    initSettingsListeners();
    populateConnectionProfiles();
}

/**
 * Add the scratch pad button to the UI
 */
function addScratchPadButton(retries = 10) {
    // Check if button already exists and remove it (stale)
    const existingButton = document.getElementById('scratch_pad_button');
    if (existingButton) {
        existingButton.remove();
    }

    // Find the extensions menu or create a button in the wand menu
    const extensionsMenu = document.getElementById('extensionsMenu');
    const wandMenu = document.getElementById('wand_menu');

    // Create button
    const button = document.createElement('div');
    button.id = 'scratch_pad_button';
    button.className = 'list-group-item flex-container flexGap5';
    button.title = 'Open Scratch Pad (OOC)';
    button.innerHTML = `
        <i class="fa-solid fa-clipboard"></i>
        <span>Scratch Pad</span>
    `;

    button.addEventListener('click', () => {
        if (!isChatActive()) {
            toastr.warning('Open a chat to use Scratch Pad');
            return;
        }
        openScratchPad();
    });

    // Add to extensions menu
    if (extensionsMenu) {
        extensionsMenu.appendChild(button);
    } else if (wandMenu) {
        // Add to wand menu as alternative
        const wandButton = button.cloneNode(true);
        wandButton.id = 'scratch_pad_wand_button';
        wandButton.addEventListener('click', () => {
            if (!isChatActive()) {
                toastr.warning('Open a chat to use Scratch Pad');
                return;
            }
            openScratchPad();
        });
        wandMenu.appendChild(wandButton);
    } else if (retries > 0) {
        setTimeout(() => addScratchPadButton(retries - 1), 500);
    } else {
        console.warn('[ScratchPad] Could not find extensions menu to insert button');
    }
}

/**
 * Handle chat change event
 */
function handleChatChanged() {
    // Ensure scratch pad data exists for new chat
    ensureScratchPadExists();

    // Refresh UI if open
    if (isScratchPadOpen()) {
        refreshScratchPadUI();
    }
}

/**
 * Initialize the extension
 */
async function init() {
    console.log(`[${EXTENSION_NAME}] Initializing...`);

    // Get context
    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    ensureStylesLoaded();

    // Initialize settings
    getSettings();

    // Initialize popup functions for commands
    initPopupFunctions();

    // Register slash commands
    registerCommands();

    // Initialize UI
    initUI();

    // Load settings HTML
    await loadSettingsHTML();

    // Add button to UI
    addScratchPadButton();

    // Ensure scratch pad exists for current chat
    ensureScratchPadExists();

    // Listen for chat changes
    if (eventSource && event_types) {
        eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    }

    console.log(`[${EXTENSION_NAME}] Initialized successfully`);
}

// Initialize when jQuery is ready (SillyTavern pattern)
if (typeof jQuery !== 'undefined') {
    jQuery(async () => {
        await init();
    });
} else {
    // Fallback for when jQuery isn't available
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}

// Export for potential external use
export { openScratchPad, closeScratchPad, isScratchPadOpen };
