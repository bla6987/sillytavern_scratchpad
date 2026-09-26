/**
 * Conversation View component for Scratch Pad extension
 */

import { getThread, getThreadForCurrentBranch, createThread, updateThread, updateThreadContextSettings, getThreadContextSettings, getMessage, saveMetadata, DEFAULT_CONTEXT_SETTINGS, ensureSwipeFields, setActiveSwipe, deleteSwipe, syncSwipeToMessage } from '../storage.js';
import { generateScratchPadResponse, editUserMessageAndRegenerate, retryMessage, regenerateMessage, generateSwipe, parseThinking, generateThreadTitle, cancelGeneration, isGenerationActive, isGuidedGenerationsInstalled, triggerGuidedSwipe } from '../generation.js';
import { warmEmbeddings } from '../semanticSearch.js';
import { formatTimestamp, renderMarkdown, createStreamingRenderer, copyTextToClipboard, createButton, showPromptDialog, showConfirmDialog, showToast, createSpinner, debounce, Icons, playCompletionSound } from './components.js';
import { speakText, isTTSAvailable } from '../tts.js';
import { getSettings, getCurrentContextSettings, isGlobalApiProfileForced } from '../settings.js';
import { getConnectionProfileLabel, PROFILE_CHANGE_EVENT, renderConnectionProfileOptions, resolveConnectionProfileId } from '../connectionProfiles.js';
import { isPinnedMode, togglePinnedMode, isFullscreenMode, getConversationContainer } from './index.js';
import { REASONING_STATE, normalizeReasoningMeta } from '../reasoning.js';
import { enqueueMessage, getQueuedMessages, dequeueNextMessage, removeQueuedMessage, takeQueuedMessages, clearMessageQueue, joinDraftText } from '../messageQueue.js';
import { isPopupGenerationActive } from './popup.js';

let conversationContainer = null;
let currentThreadId = null;
let activeGenerationId = null;
let pendingMessage = null;
let inputDraft = '';
let cleanupFunctions = [];
let currentViewportHandler = null;
let currentViewportBusUnsubscribe = null;
let lastRenderedThreadId = null;
let lastRenderedMessageCount = -1;
let lastRenderedMessageStatus = null;
let lastRenderedMessageId = null;
// Queued text sent back by a cancelled/failed reply while its thread was off screen
const returnedDrafts = new Map();

/**
 * Start a new generation and return its ID
 * @returns {string} Generation ID
 */
function startGeneration() {
    const id = `gen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    activeGenerationId = id;
    return id;
}

/**
 * Check if the given ID is the current active generation
 * @param {string} id Generation ID
 * @returns {boolean} True if this is the active generation
 */
function isOurGeneration(id) {
    return activeGenerationId === id;
}

/**
 * End the generation if it matches the given ID
 * @param {string} id Generation ID
 */
function endGeneration(id) {
    if (activeGenerationId === id) {
        activeGenerationId = null;
    }
}

/**
 * Check if a generation is currently active
 * @returns {boolean} True if generating
 */
function isGenerating() {
    return activeGenerationId !== null || isGenerationActive() || isPopupGenerationActive();
}

/**
 * Register a cleanup function to be called on view refresh
 * @param {Function} fn Cleanup function
 */
function registerCleanup(fn) {
    cleanupFunctions.push(fn);
}

/**
 * Run all registered cleanup functions
 */
function runCleanups() {
    cleanupFunctions.forEach(fn => fn());
    cleanupFunctions = [];
}

/**
 * Open a thread in conversation view
 * @param {string} threadId Thread ID
 * @param {string} [initialMessage] Optional message to send immediately
 */
export function openThread(threadId, initialMessage = null) {
    currentThreadId = threadId;
    pendingMessage = initialMessage;
    inputDraft = returnedDrafts.get(threadId) ?? '';
    returnedDrafts.delete(threadId);

    const content = getConversationContainer();
    if (!content) return;

    renderConversation(content);
}

/**
 * Start a new thread (empty conversation view)
 */
export function startNewThread() {
    currentThreadId = null;
    pendingMessage = null;
    inputDraft = '';

    const content = getConversationContainer();
    if (!content) return;

    renderConversation(content, true);
}

/**
 * Render the conversation view
 * @param {HTMLElement} container Container element
 * @param {boolean} isNewThread Whether this is a new thread
 */
export function renderConversation(container, isNewThread = false) {
    conversationContainer = container;

    // Run cleanup functions from previous render
    runCleanups();

    // Use branch-filtered thread for display (hides messages from "future" branches)
    const thread = currentThreadId ? getThreadForCurrentBranch(currentThreadId) : null;

    // Track rendered state for refreshConversation optimization
    lastRenderedThreadId = currentThreadId;
    lastRenderedMessageCount = thread ? thread.messages.length : 0;
    const lastMsg = thread?.messages?.[thread.messages.length - 1];
    lastRenderedMessageStatus = lastMsg?.status ?? null;
    lastRenderedMessageId = lastMsg?.id ?? null;

    // Re-renders replace the input, so remember where the user was typing
    const previousInput = container.querySelector('#sp-message-input');
    const inputSelection = previousInput && previousInput === document.activeElement
        ? [previousInput.selectionStart, previousInput.selectionEnd]
        : null;

    container.innerHTML = '';
    // Preserve sp-drawer-content class while adding view-specific class
    container.className = 'sp-drawer-content sp-conversation-view';

    // Header
    const header = document.createElement('div');
    header.className = 'sp-header sp-conversation-header';

    const backBtn = createButton({
        icon: Icons.back,
        className: 'sp-back-btn',
        ariaLabel: 'Back to thread list',
        onClick: () => goBackToThreadList()
    });
    header.appendChild(backBtn);

    const titleContainer = document.createElement('div');
    titleContainer.className = 'sp-title-container';

    const titleEl = document.createElement('h2');
    titleEl.className = 'sp-title sp-thread-title';
    titleEl.textContent = thread ? thread.name : 'New Thread';
    titleEl.addEventListener('click', () => {
        if (thread) {
            handleRenameThread(thread);
        }
    });
    titleContainer.appendChild(titleEl);

    const subtitleEl = document.createElement('span');
    subtitleEl.className = 'sp-subtitle';
    subtitleEl.textContent = 'Out of Character';
    titleContainer.appendChild(subtitleEl);

    header.appendChild(titleContainer);

    // AI Rename button (only show for existing threads with messages)
    if (thread && thread.messages.length > 0) {
        const aiRenameBtn = createButton({
            icon: Icons.aiRename,
            className: 'sp-ai-rename-btn',
            ariaLabel: 'Rename with AI',
            onClick: () => handleAiRename(thread)
        });
        header.appendChild(aiRenameBtn);
    }

    // Pin button
    const pinBtn = createButton({
        icon: Icons.pin,
        className: `sp-header-btn sp-pin-btn ${isPinnedMode() ? 'sp-pinned-active' : ''}`,
        ariaLabel: isPinnedMode() ? 'Unpin drawer' : 'Pin drawer to side',
        onClick: () => {
            const newState = togglePinnedMode();
            pinBtn.classList.toggle('sp-pinned-active', newState);
            pinBtn.setAttribute('aria-label', newState ? 'Unpin drawer' : 'Pin drawer to side');
        }
    });
    header.appendChild(pinBtn);

    const closeBtn = createButton({
        icon: Icons.close,
        className: 'sp-close-btn',
        ariaLabel: 'Close scratch pad',
        onClick: () => closeScratchPadDrawer()
    });
    header.appendChild(closeBtn);

    container.appendChild(header);

    // Context options section
    renderContextOptions(container, thread, isNewThread);

    // Messages area
    const messagesContainer = document.createElement('div');
    messagesContainer.className = 'sp-messages';
    messagesContainer.id = 'sp-messages';

    if (thread && thread.messages.length > 0) {
        // Implement virtual scrolling for large threads
        const messagesToShow = thread.messages.length > 50
            ? thread.messages.slice(-50)
            : thread.messages;

        if (thread.messages.length > 50) {
            const loadMoreBtn = createButton({
                text: `Load ${thread.messages.length - 50} earlier messages`,
                className: 'sp-load-more-btn',
                onClick: () => loadAllMessages(thread)
            });
            messagesContainer.appendChild(loadMoreBtn);
        }

        messagesToShow.forEach(msg => {
            const msgEl = createMessageElement(msg);
            messagesContainer.appendChild(msgEl);
        });

        renderBranchedMessages(thread, messagesContainer);
    } else if (!isNewThread && thread) {
        const hasBranchedMessages = thread.branchedMessages && thread.branchedMessages.length > 0;
        if (!hasBranchedMessages) {
            const emptyState = document.createElement('div');
            emptyState.className = 'sp-empty-state';
            emptyState.innerHTML = `<p>No messages yet. Ask a question below.</p>`;
            messagesContainer.appendChild(emptyState);
        }
        renderBranchedMessages(thread, messagesContainer, hasBranchedMessages);
    } else {
        const emptyState = document.createElement('div');
        emptyState.className = 'sp-empty-state';
        emptyState.innerHTML = `
            <div class="sp-empty-icon">${Icons.thread}</div>
            <p>Start a new conversation.</p>
            <p>Ask any out-of-character question about your roleplay.</p>
        `;
        messagesContainer.appendChild(emptyState);
    }

    container.appendChild(messagesContainer);

    // Input area
    const inputContainer = document.createElement('div');
    inputContainer.className = 'sp-input-container';

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'sp-input-wrapper';

    const textarea = document.createElement('textarea');
    textarea.className = 'sp-message-input';
    textarea.id = 'sp-message-input';
    textarea.placeholder = 'Ask a question...';
    textarea.rows = 2;
    textarea.value = inputDraft;
    textarea.addEventListener('input', () => {
        inputDraft = textarea.value;
    });

    const sendBtn = createButton({
        icon: Icons.send,
        text: 'Send',
        className: 'sp-send-btn',
        onClick: () => handleSendMessage()
    });
    sendBtn.id = 'sp-send-btn';

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage().catch(err => {
                console.error('[ScratchPad] Send message error:', err);
            });
        }
    });

    // Auto-resize textarea (CSS max-height constrains the final size)
    textarea.addEventListener('input', debounce(() => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    }, 50));

    inputWrapper.appendChild(textarea);
    inputWrapper.appendChild(sendBtn);
    inputContainer.appendChild(inputWrapper);
    container.appendChild(inputContainer);

    if (textarea.value && textarea.scrollHeight) {
        textarea.style.height = textarea.scrollHeight + 'px';
    }
    if (inputSelection) {
        textarea.focus();
        textarea.setSelectionRange(...inputSelection);
    }

    // The input stays usable while generating; sends are queued until the reply finishes
    const hasPendingAssistantMessage = thread?.messages?.some(message =>
        message.role === 'assistant' && message.status === 'pending'
    );
    if (hasPendingAssistantMessage && isGenerating()) {
        showGeneratingIndicator(true, handleCancelGeneration);
    }
    renderMessageQueue();
    updateSendButtonMode();

    // Scroll to bottom
    scrollToBottom();

    // Focus input
    setTimeout(() => {
        textarea.focus();

        // Handle pending message
        if (pendingMessage) {
            textarea.value = pendingMessage;
            inputDraft = pendingMessage;
            pendingMessage = null;
            handleSendMessage();
        }
    }, 100);

    // Handle keyboard/viewport
    setupViewportHandlers();
}

/**
 * Render context options section for the conversation view
 * @param {HTMLElement} container Container element
 * @param {Object} thread Thread object (null for new threads)
 * @param {boolean} isNewThread Whether this is a new thread
 */
function renderContextOptions(container, thread, isNewThread) {
    const contextSection = document.createElement('div');
    contextSection.className = 'sp-context-options';
    contextSection.id = 'sp-context-options';

    // Get context settings (thread's or defaults for new)
    const contextSettings = thread?.contextSettings
        ? { ...DEFAULT_CONTEXT_SETTINGS, ...thread.contextSettings }
        : getCurrentContextSettings();
    const globalApiProfileForced = isGlobalApiProfileForced();

    // Badges row for context summary and profile
    const badgesRow = document.createElement('div');
    badgesRow.className = 'sp-context-badges';

    // Summary badge showing current mode
    const summaryBadge = document.createElement('div');
    summaryBadge.className = 'sp-context-summary';
    summaryBadge.id = 'sp-context-summary';
    summaryBadge.textContent = getContextSummaryText(contextSettings);
    badgesRow.appendChild(summaryBadge);

    // Profile badge showing current profile override
    const profileBadge = document.createElement('div');
    profileBadge.className = 'sp-profile-badge';
    profileBadge.id = 'sp-profile-badge';
    profileBadge.textContent = getProfileBadgeText(contextSettings);
    profileBadge.style.display = globalApiProfileForced || getConfiguredProfileValue(contextSettings) ? 'inline-block' : 'none';
    badgesRow.appendChild(profileBadge);

    contextSection.appendChild(badgesRow);

    // Collapsible details for full options
    const details = document.createElement('details');
    details.className = 'sp-context-details';

    const summary = document.createElement('summary');
    summary.textContent = 'Context Options';
    details.appendChild(summary);

    const optionsBlock = document.createElement('div');
    optionsBlock.className = 'sp-context-options-block';

    // Generate unique IDs for this instance to avoid conflicts
    const idPrefix = 'sp_thread_';
    const profileControlDisabled = globalApiProfileForced ? 'disabled' : '';
    const profileHelpText = globalApiProfileForced
        ? 'Global API profile override is enabled in Scratch Pad settings; thread-level profiles are ignored.'
        : 'Override which API profile to use for this thread.';

    optionsBlock.innerHTML = `
        <label for="${idPrefix}connection_profile">
            <span>Connection Profile:</span>
            <small>${profileHelpText}</small>
        </label>
        <div class="range-block">
            <select id="${idPrefix}connection_profile" class="text_pole" ${profileControlDisabled}>
                <option value="">Use Global Setting</option>
            </select>
        </div>

        <label for="${idPrefix}range_mode">
            <span>Chat history range:</span>
            <small>Which messages to send (1-based).</small>
        </label>
        <div class="range-block">
            <select id="${idPrefix}range_mode" class="text_pole">
                <option value="all">All messages</option>
                <option value="start_to">From start to message #</option>
                <option value="from_to_end">From message # to end</option>
                <option value="between">Between message # and #</option>
            </select>
        </div>
        <div id="${idPrefix}range_inputs" class="flex-container" style="display: ${contextSettings.chatHistoryRangeMode === 'all' ? 'none' : 'flex'};">
            <input type="number" id="${idPrefix}range_start" class="text_pole" min="1" step="1" placeholder="Start #" value="${contextSettings.chatHistoryRangeStart ?? ''}">
            <span>to</span>
            <input type="number" id="${idPrefix}range_end" class="text_pole" min="1" step="1" placeholder="End #" value="${contextSettings.chatHistoryRangeEnd ?? ''}">
        </div>

        <label class="checkbox_label" for="${idPrefix}char_card_only">
            <input type="checkbox" id="${idPrefix}char_card_only" ${contextSettings.characterCardOnly ? 'checked' : ''}>
            <span>Character Card Only</span>
            <small>Skip chat history, send only character info</small>
        </label>

        <label class="checkbox_label" for="${idPrefix}include_char_card">
            <input type="checkbox" id="${idPrefix}include_char_card" ${contextSettings.includeCharacterCard ? 'checked' : ''}>
            <span>Include Character Card</span>
        </label>

        <label class="checkbox_label" for="${idPrefix}include_sys_prompt">
            <input type="checkbox" id="${idPrefix}include_sys_prompt" ${contextSettings.includeSystemPrompt ? 'checked' : ''}>
            <span>Include System Prompt</span>
        </label>

        <label class="checkbox_label" for="${idPrefix}include_authors_note">
            <input type="checkbox" id="${idPrefix}include_authors_note" ${contextSettings.includeAuthorsNote ? 'checked' : ''}>
            <span>Include Author's Note</span>
        </label>
    `;

    details.appendChild(optionsBlock);
    contextSection.appendChild(details);
    container.appendChild(contextSection);

    // Load values and bind listeners
    loadThreadContextUI(contextSettings, idPrefix);
    bindThreadContextListeners(thread?.id, isNewThread, idPrefix);

    // Populate profile dropdown asynchronously
    populateThreadProfileDropdown(globalApiProfileForced ? null : getConfiguredProfileValue(contextSettings), idPrefix);

    const refreshProfiles = () => {
        populateThreadProfileDropdown(isGlobalApiProfileForced() ? null : getContextSettingsFromUI().connectionProfileId, idPrefix);
        updateProfileBadge(idPrefix);
    };
    window.addEventListener(PROFILE_CHANGE_EVENT, refreshProfiles);
    registerCleanup(() => window.removeEventListener(PROFILE_CHANGE_EVENT, refreshProfiles));
}

function getConfiguredProfileValue(contextSettings) {
    return contextSettings.connectionProfileId || contextSettings.connectionProfile || null;
}

/**
 * Get badge text for profile override
 * @param {Object} contextSettings Context settings object
 * @returns {string} Profile badge text
 */
function getProfileBadgeText(contextSettings) {
    if (isGlobalApiProfileForced()) {
        const settings = getSettings();
        const profileValue = settings.connectionProfileId || settings.connectionProfile;
        return profileValue ? `Global: ${getConnectionProfileLabel(profileValue)}` : 'Global API override';
    }

    const profileValue = getConfiguredProfileValue(contextSettings);
    if (profileValue) {
        return getConnectionProfileLabel(profileValue);
    }
    return 'Default';
}

/**
 * Update the profile badge display
 * @param {string} idPrefix ID prefix for elements
 */
function updateProfileBadge(idPrefix) {
    const profileBadge = document.getElementById('sp-profile-badge');
    const profileSelect = document.getElementById(`${idPrefix}connection_profile`);
    if (!profileBadge || !profileSelect) return;

    if (isGlobalApiProfileForced()) {
        profileBadge.textContent = getProfileBadgeText({});
        profileBadge.style.display = 'inline-block';
        return;
    }

    const profileId = profileSelect.value;
    if (profileId) {
        profileBadge.textContent = getConnectionProfileLabel(profileId);
        profileBadge.style.display = 'inline-block';
    } else {
        profileBadge.style.display = 'none';
    }
}

/**
 * Populate the thread profile dropdown with available profiles
 * @param {string|null} currentProfile Currently selected profile ID or legacy name
 * @param {string} idPrefix ID prefix for elements
 */
async function populateThreadProfileDropdown(currentProfile, idPrefix) {
    const profileSelect = document.getElementById(`${idPrefix}connection_profile`);
    if (!profileSelect) return;

    const shouldDisable = isGlobalApiProfileForced();
    renderConnectionProfileOptions(profileSelect, currentProfile, {
        defaultLabel: 'Use Global Setting',
    });
    profileSelect.disabled = shouldDisable || profileSelect.disabled;
    if (shouldDisable) {
        profileSelect.value = '';
    }
}

/**
 * Get summary text for context settings
 * @param {Object} contextSettings Context settings object
 * @returns {string} Summary text
 */
function getContextSummaryText(contextSettings) {
    if (contextSettings.characterCardOnly) {
        return 'Card Only';
    }

    const mode = contextSettings.chatHistoryRangeMode || 'all';
    const start = contextSettings.chatHistoryRangeStart;
    const end = contextSettings.chatHistoryRangeEnd;

    switch (mode) {
        case 'all':
            return 'All messages';
        case 'start_to':
            return end ? `Messages 1-${end}` : 'All messages';
        case 'from_to_end':
            return start ? `Messages ${start}+` : 'All messages';
        case 'between':
            if (start && end) {
                return `Messages ${start}-${end}`;
            }
            return 'All messages';
        default:
            return 'All messages';
    }
}

/**
 * Load thread context settings into UI
 * @param {Object} contextSettings Context settings
 * @param {string} idPrefix ID prefix for elements
 */
function loadThreadContextUI(contextSettings, idPrefix) {
    const rangeModeSelect = document.getElementById(`${idPrefix}range_mode`);
    if (rangeModeSelect) {
        rangeModeSelect.value = contextSettings.chatHistoryRangeMode || 'all';
    }
}

/**
 * Bind event listeners for thread context options
 * @param {string|null} threadId Thread ID (null for new threads)
 * @param {boolean} isNewThread Whether this is a new thread
 * @param {string} idPrefix ID prefix for elements
 */
function bindThreadContextListeners(threadId, isNewThread, idPrefix) {
    const profileSelect = document.getElementById(`${idPrefix}connection_profile`);
    const rangeModeSelect = document.getElementById(`${idPrefix}range_mode`);
    const rangeStartInput = document.getElementById(`${idPrefix}range_start`);
    const rangeEndInput = document.getElementById(`${idPrefix}range_end`);
    const rangeInputsContainer = document.getElementById(`${idPrefix}range_inputs`);
    const charCardOnlyToggle = document.getElementById(`${idPrefix}char_card_only`);
    const includeCharCardToggle = document.getElementById(`${idPrefix}include_char_card`);
    const includeSysPromptToggle = document.getElementById(`${idPrefix}include_sys_prompt`);
    const includeAuthorsNoteToggle = document.getElementById(`${idPrefix}include_authors_note`);

    const updateContextSetting = async (key, value) => {
        if (threadId) {
            updateThreadContextSettings(threadId, { [key]: value });
            await saveMetadata();
        }
        updateContextSummary(idPrefix);
    };

    if (profileSelect) {
        profileSelect.addEventListener('change', (e) => {
            const profileId = e.target.value || null;
            updateContextSetting('connectionProfileId', profileId);
            updateContextSetting('connectionProfile', null);
            updateProfileBadge(idPrefix);
        });
    }

    if (rangeModeSelect) {
        rangeModeSelect.addEventListener('change', (e) => {
            const mode = e.target.value;
            updateContextSetting('chatHistoryRangeMode', mode);
            if (rangeInputsContainer) {
                rangeInputsContainer.style.display = mode === 'all' ? 'none' : 'flex';
            }
        });
    }

    if (rangeStartInput) {
        rangeStartInput.addEventListener('input', (e) => {
            const value = parseRangeNumber(e.target.value);
            updateContextSetting('chatHistoryRangeStart', value);
        });
    }

    if (rangeEndInput) {
        rangeEndInput.addEventListener('input', (e) => {
            const value = parseRangeNumber(e.target.value);
            updateContextSetting('chatHistoryRangeEnd', value);
        });
    }

    if (charCardOnlyToggle) {
        charCardOnlyToggle.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            updateContextSetting('characterCardOnly', enabled);
            if (enabled && includeCharCardToggle) {
                includeCharCardToggle.checked = true;
                updateContextSetting('includeCharacterCard', true);
            }
        });
    }

    if (includeCharCardToggle) {
        includeCharCardToggle.addEventListener('change', (e) => {
            updateContextSetting('includeCharacterCard', e.target.checked);
        });
    }

    if (includeSysPromptToggle) {
        includeSysPromptToggle.addEventListener('change', (e) => {
            updateContextSetting('includeSystemPrompt', e.target.checked);
        });
    }

    if (includeAuthorsNoteToggle) {
        includeAuthorsNoteToggle.addEventListener('change', (e) => {
            updateContextSetting('includeAuthorsNote', e.target.checked);
        });
    }
}

/**
 * Parse a range number input value
 * @param {string} value Input value
 * @returns {number|null} Parsed number or null
 */
function parseRangeNumber(value) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return null;
    return parsed;
}

/**
 * Update the context summary badge
 * @param {string} idPrefix ID prefix for elements
 */
function updateContextSummary(idPrefix) {
    const summaryEl = document.getElementById('sp-context-summary');
    if (!summaryEl) return;

    const contextSettings = getContextSettingsFromUI();
    summaryEl.textContent = getContextSummaryText(contextSettings);
}

/**
 * Get context settings from the UI elements
 * @returns {Object} Context settings from current UI state
 */
function getContextSettingsFromUI() {
    const idPrefix = 'sp_thread_';
    const profileSelect = document.getElementById(`${idPrefix}connection_profile`);
    const rangeModeSelect = document.getElementById(`${idPrefix}range_mode`);
    const rangeStartInput = document.getElementById(`${idPrefix}range_start`);
    const rangeEndInput = document.getElementById(`${idPrefix}range_end`);
    const charCardOnlyToggle = document.getElementById(`${idPrefix}char_card_only`);
    const includeCharCardToggle = document.getElementById(`${idPrefix}include_char_card`);
    const includeSysPromptToggle = document.getElementById(`${idPrefix}include_sys_prompt`);
    const includeAuthorsNoteToggle = document.getElementById(`${idPrefix}include_authors_note`);

    return {
        connectionProfileId: resolveConnectionProfileId(profileSelect?.value) || profileSelect?.value || null,
        connectionProfile: null,
        chatHistoryRangeMode: rangeModeSelect?.value || 'all',
        chatHistoryRangeStart: parseRangeNumber(rangeStartInput?.value),
        chatHistoryRangeEnd: parseRangeNumber(rangeEndInput?.value),
        characterCardOnly: charCardOnlyToggle?.checked || false,
        includeCharacterCard: includeCharCardToggle?.checked ?? true,
        includeSystemPrompt: includeSysPromptToggle?.checked || false,
        includeAuthorsNote: includeAuthorsNoteToggle?.checked || false
    };
}

/**
 * Render collapsible section for branched (off-branch) messages
 * @param {Object} thread Thread object with branchedMessages
 * @param {HTMLElement} container Container to append into
 */
function renderBranchedMessages(thread, container, autoExpand = false) {
    if (!thread.branchedMessages || thread.branchedMessages.length === 0) return;

    const details = document.createElement('details');
    details.className = 'sp-branched-messages';
    if (autoExpand) {
        details.open = true;
    }

    const summary = document.createElement('summary');
    const count = thread.branchedMessages.length;
    summary.textContent = `${count} message${count !== 1 ? 's' : ''} from other branches`;
    details.appendChild(summary);

    const content = document.createElement('div');
    content.className = 'sp-branched-messages-content';
    thread.branchedMessages.forEach(msg => {
        const msgEl = createMessageElement(msg);
        content.appendChild(msgEl);
    });
    details.appendChild(content);

    container.appendChild(details);
}

function formatReasoningDuration(durationMs) {
    const duration = Number(durationMs);
    if (!Number.isFinite(duration) || duration <= 0) return '';
    if (duration >= 10000) return `${Math.round(duration / 1000)}s`;
    return `${(duration / 1000).toFixed(1)}s`;
}

function formatGenerationDuration(genStarted, genFinished) {
    const start = Date.parse(genStarted);
    const finish = Date.parse(genFinished);
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return '';

    const seconds = (finish - start) / 1000;
    if (seconds >= 100) return `${Math.round(seconds)}s`;
    if (seconds >= 10) return `${seconds.toFixed(1)}s`;
    return `${seconds.toFixed(2)}s`;
}

function trimGenerationMetaValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function getGenerationExtra(message) {
    const extra = message?.extra && typeof message.extra === 'object' ? message.extra : {};
    const api = trimGenerationMetaValue(extra.api);
    const model = trimGenerationMetaValue(extra.model);
    return api || model ? { api, model } : null;
}

function formatGenerationModelTitle(extra) {
    if (!extra) return '';
    if (extra.api && extra.model) return `${extra.api} - ${extra.model}`;
    return extra.model || extra.api || '';
}

function createGenerationModelIcon(extra) {
    if (!extra?.api) return null;

    const iconName = extra.api.replace(/[^a-z0-9_-]/gi, '');
    if (!iconName) return null;

    const title = formatGenerationModelTitle(extra);
    const image = new Image();
    image.className = 'icon-svg timestamp-icon sp-message-model-icon';
    image.alt = title || extra.api;
    image.title = title;
    image.addEventListener('load', () => {
        try {
            globalThis.SVGInject?.(image);
        } catch {
            // SillyTavern may not expose SVGInject in tests or older builds.
        }
    }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = `/img/${encodeURIComponent(iconName)}.svg`;
    return image;
}

function appendReasoningSection(container, thinking, reasoningMeta) {
    const normalizedMeta = normalizeReasoningMeta(reasoningMeta, thinking);

    if (thinking) {
        const thinkingEl = document.createElement('details');
        thinkingEl.className = 'sp-thinking';
        thinkingEl.innerHTML = `
            <summary>💭 Model Thinking</summary>
            <div class="sp-thinking-content">${renderMarkdown(thinking)}</div>
        `;
        container.appendChild(thinkingEl);
        return;
    }

    if (normalizedMeta.state === REASONING_STATE.HIDDEN) {
        const hiddenEl = document.createElement('div');
        hiddenEl.className = 'sp-thinking-hidden';
        const duration = formatReasoningDuration(normalizedMeta.durationMs);
        hiddenEl.textContent = duration
            ? `Model reasoning hidden by provider (${duration})`
            : 'Model reasoning hidden by provider';
        container.appendChild(hiddenEl);
    }
}

/**
 * Create a message element
 * @param {Object} message Message object
 * @returns {HTMLElement} Message element
 */
function createMessageElement(message) {
    const msgEl = document.createElement('div');
    msgEl.className = `sp-message sp-message-${message.role}`;
    msgEl.dataset.messageId = message.id;
    const isComplete = !message.status || message.status === 'complete';

    if (message.status === 'failed') {
        msgEl.classList.add('sp-message-failed');
    }

    // Role label
    const roleRowEl = document.createElement('div');
    roleRowEl.className = 'sp-message-role-row';

    const roleEl = document.createElement('div');
    roleEl.className = 'sp-message-role';
    roleEl.textContent = message.role === 'user' ? 'You' : 'Assistant';
    roleRowEl.appendChild(roleEl);

    if (message.noContext) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'sp-message-badge sp-message-badge-nocontext';
        badgeEl.textContent = 'No Context';
        roleRowEl.appendChild(badgeEl);
    }

    msgEl.appendChild(roleRowEl);

    // For assistant messages, wrap content with swipe controls
    const isAssistant = message.role === 'assistant';
    const hasSwipes = isAssistant && message.swipes && message.swipes.length > 1;

    // Content
    const contentEl = document.createElement('div');
    contentEl.className = 'sp-message-content';

    if (message.status === 'pending') {
        contentEl.appendChild(createSpinner());
    } else if (message.status === 'failed') {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'sp-error-message';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'sp-error-icon';
        iconSpan.innerHTML = Icons.error;
        const textSpan = document.createElement('span');
        textSpan.textContent = `Generation failed${message.error ? `: ${message.error}` : ''}`;
        errorDiv.appendChild(iconSpan);
        errorDiv.appendChild(textSpan);
        contentEl.appendChild(errorDiv);

        const retryBtn = createButton({
            icon: Icons.retry,
            text: 'Retry',
            className: 'sp-retry-btn',
            onClick: () => handleRetry(message.id)
        });
        contentEl.appendChild(retryBtn);
    } else if (message.status === 'cancelled') {
        contentEl.innerHTML = '<div class="sp-cancelled-message"><span>Generation cancelled</span></div>';
    } else {
        if (isAssistant) {
            appendReasoningSection(contentEl, message.thinking, message.reasoningMeta);
        }

        // Render main content
        const mainContent = document.createElement('div');
        mainContent.className = 'sp-message-main-content';
        mainContent.innerHTML = renderMarkdown(message.content);
        contentEl.appendChild(mainContent);
    }

    // Swipe wrapper for assistant messages
    if (isAssistant) {
        const swipeWrapper = document.createElement('div');
        swipeWrapper.className = 'sp-swipe-wrapper';

        // Left arrow
        const leftArrow = createButton({
            icon: Icons.chevronLeft,
            className: 'sp-swipe-arrow sp-swipe-left',
            ariaLabel: 'Previous swipe',
            onClick: () => handleSwipeNavigation(message.id, -1)
        });
        leftArrow.disabled = !hasSwipes || (message.swipeId ?? 0) === 0;

        // Right arrow
        const isAtEnd = hasSwipes && (message.swipeId ?? 0) === (message.swipes?.length ?? 1) - 1;
        const rightArrow = createButton({
            icon: Icons.chevronRight,
            className: `sp-swipe-arrow sp-swipe-right${isAtEnd || !hasSwipes ? ' sp-swipe-generate' : ''}`,
            ariaLabel: isAtEnd || !hasSwipes ? 'Generate new swipe' : 'Next swipe',
            onClick: () => handleSwipeNavigation(message.id, 1)
        });

        swipeWrapper.appendChild(leftArrow);
        swipeWrapper.appendChild(contentEl);
        swipeWrapper.appendChild(rightArrow);

        // Hide arrows when only 1 swipe and message is complete
        if (!hasSwipes && isComplete && message.content) {
            leftArrow.classList.add('sp-swipe-hidden');
            rightArrow.classList.add('sp-swipe-hidden');
        }

        msgEl.appendChild(swipeWrapper);

        // Swipe info row (counter + delete)
        if (hasSwipes) {
            const swipeInfo = document.createElement('div');
            swipeInfo.className = 'sp-swipe-info';

            const counter = document.createElement('span');
            counter.className = 'sp-swipe-counter';
            counter.textContent = `${(message.swipeId ?? 0) + 1} / ${message.swipes.length}`;
            swipeInfo.appendChild(counter);

            const deleteBtn = createButton({
                icon: Icons.delete,
                className: 'sp-swipe-delete',
                ariaLabel: 'Delete this swipe',
                onClick: () => handleDeleteSwipe(message.id)
            });
            swipeInfo.appendChild(deleteBtn);

            msgEl.appendChild(swipeInfo);
        }
    } else {
        msgEl.appendChild(contentEl);
    }

    // Message footer with timestamp and actions
    const footerEl = document.createElement('div');
    footerEl.className = 'sp-message-footer';

    const metaEl = document.createElement('div');
    metaEl.className = 'sp-message-meta';

    // Timestamp
    const generationExtra = isAssistant ? getGenerationExtra(message) : null;
    const timestampRowEl = document.createElement('div');
    timestampRowEl.className = 'sp-message-timestamp-row';
    const modelIcon = createGenerationModelIcon(generationExtra);
    if (modelIcon) {
        timestampRowEl.appendChild(modelIcon);
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'sp-message-time';
    timeEl.textContent = formatTimestamp(message.timestamp);
    const generationTitle = formatGenerationModelTitle(generationExtra);
    if (generationTitle) {
        timeEl.title = generationTitle;
    }
    timestampRowEl.appendChild(timeEl);
    metaEl.appendChild(timestampRowEl);

    if (isAssistant) {
        const generationDuration = formatGenerationDuration(message.gen_started, message.gen_finished);
        if (generationDuration) {
            const durationEl = document.createElement('div');
            durationEl.className = 'sp-message-generation-time';
            durationEl.textContent = `Generated in ${generationDuration}`;
            metaEl.appendChild(durationEl);
        }
    }

    footerEl.appendChild(metaEl);

    // Actions for assistant messages
    if (isAssistant && isComplete && message.content) {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'sp-message-actions';

        // Regenerate button
        const regenerateBtn = createButton({
            icon: Icons.retry,
            className: 'sp-action-btn',
            ariaLabel: 'Regenerate response',
            onClick: () => handleRegenerate(message.id)
        });
        actionsEl.appendChild(regenerateBtn);

        // Copy button
        const copyBtn = createButton({
            icon: Icons.copy,
            className: 'sp-action-btn',
            ariaLabel: 'Copy to clipboard',
            onClick: async () => {
                const currentMsg = currentThreadId ? getMessage(currentThreadId, message.id) : null;
                const content = currentMsg?.content || message.content;
                try {
                    await copyTextToClipboard(content);
                    showToast('Copied to clipboard', 'success');
                } catch {
                    showToast('Failed to copy', 'error');
                }
            }
        });
        actionsEl.appendChild(copyBtn);

        // Apply to Guided Swipe button (only if GG is installed)
        // Read content at click time (stays in sync via syncSwipeToMessage)
        if (isGuidedGenerationsInstalled()) {
            const applySwipeBtn = createButton({
                icon: Icons.swipe,
                text: 'Apply Swipe',
                className: 'sp-action-btn sp-apply-swipe',
                ariaLabel: 'Use this response as guidance for a swipe',
                onClick: async () => {
                    const currentMsg = currentThreadId ? getMessage(currentThreadId, message.id) : null;
                    const content = currentMsg?.content || message.content;
                    applySwipeBtn.disabled = true;
                    const result = await triggerGuidedSwipe(content);
                    applySwipeBtn.disabled = false;

                    if (result.success) {
                        showToast('Guided swipe triggered', 'success');
                    } else {
                        showToast(result.error, 'error');
                    }
                }
            });
            actionsEl.appendChild(applySwipeBtn);
        }

        // TTS speak button (only if TTS is enabled)
        // Read content at click time (stays in sync via syncSwipeToMessage)
        if (isTTSAvailable()) {
            const speakBtn = createButton({
                icon: Icons.speak,
                className: 'sp-speak-btn',
                ariaLabel: 'Speak this message',
                onClick: async () => {
                    const currentMsg = currentThreadId ? getMessage(currentThreadId, message.id) : null;
                    const content = currentMsg?.content || message.content;
                    speakBtn.disabled = true;
                    speakBtn.classList.add('sp-speaking');
                    try {
                        const success = await speakText(content);
                        if (!success) {
                            showToast('TTS failed. Check your TTS settings.', 'warning');
                        }
                    } finally {
                        speakBtn.disabled = false;
                        speakBtn.classList.remove('sp-speaking');
                    }
                }
            });
            actionsEl.appendChild(speakBtn);
        }

        if (actionsEl.children.length > 0) {
            footerEl.appendChild(actionsEl);
        }
    } else if (!isAssistant && isComplete && message.content) {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'sp-message-actions';

        const editBtn = createButton({
            icon: Icons.edit,
            className: 'sp-action-btn',
            ariaLabel: 'Edit message',
            onClick: () => beginEditUserMessage(message.id)
        });
        actionsEl.appendChild(editBtn);
        footerEl.appendChild(actionsEl);
    }

    msgEl.appendChild(footerEl);

    return msgEl;
}

/**
 * Replace a user message with an inline editor.
 * @param {string} messageId Message ID
 */
function beginEditUserMessage(messageId) {
    if (isGenerating() || !currentThreadId) return;

    const message = getMessage(currentThreadId, messageId);
    if (!message || message.role !== 'user') return;

    const msgEl = document.querySelector(`.sp-message[data-message-id="${messageId}"]`);
    const contentEl = msgEl?.querySelector('.sp-message-content');
    if (!msgEl || !contentEl) return;

    msgEl.classList.add('sp-message-editing');
    contentEl.innerHTML = '';

    const editorEl = document.createElement('div');
    editorEl.className = 'sp-message-edit-form';

    const textarea = document.createElement('textarea');
    textarea.className = 'sp-message-edit-input';
    textarea.value = message.content || '';
    textarea.rows = Math.min(8, Math.max(3, textarea.value.split('\n').length));

    const resizeEditor = () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
    };
    textarea.addEventListener('input', resizeEditor);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'sp-message-edit-actions';

    const saveBtn = createButton({
        icon: Icons.send,
        text: 'Save',
        className: 'sp-edit-save-btn',
        onClick: () => submitEditedUserMessage(messageId, textarea.value)
    });

    const cancelBtn = createButton({
        icon: Icons.close,
        text: 'Cancel',
        className: 'sp-edit-cancel-btn',
        onClick: () => cancelEditUserMessage(messageId)
    });

    textarea.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submitEditedUserMessage(messageId, textarea.value);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEditUserMessage(messageId);
        }
    });

    actionsEl.appendChild(saveBtn);
    actionsEl.appendChild(cancelBtn);
    editorEl.appendChild(textarea);
    editorEl.appendChild(actionsEl);
    contentEl.appendChild(editorEl);

    requestAnimationFrame(() => {
        resizeEditor();
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
}

/**
 * Restore a user message from its inline editor.
 * @param {string} messageId Message ID
 */
function cancelEditUserMessage(messageId) {
    if (!currentThreadId) return;

    const message = getMessage(currentThreadId, messageId);
    const msgEl = document.querySelector(`.sp-message[data-message-id="${messageId}"]`);
    if (!message || !msgEl) return;

    msgEl.replaceWith(createMessageElement(message));
}

/**
 * Save an edited user message and regenerate the assistant response from there.
 * @param {string} messageId Message ID
 * @param {string} editedContent Edited content
 */
async function submitEditedUserMessage(messageId, editedContent) {
    if (isGenerating() || !currentThreadId) return;

    const message = getMessage(currentThreadId, messageId);
    if (!message || message.role !== 'user') return;

    const trimmedContent = String(editedContent || '').trim();
    if (!trimmedContent) {
        showToast('Message cannot be empty', 'warning');
        return;
    }

    if (trimmedContent === String(message.content || '').trim()) {
        cancelEditUserMessage(messageId);
        return;
    }

    const threadId = currentThreadId;
    const generationId = startGeneration();
    showGeneratingIndicator(true, handleCancelGeneration);

    let streamingMsgEl = null;
    let succeeded = false;

    try {
        let _latestEditResponse = '';
        const editRenderer = createStreamingRenderer(
            () => streamingMsgEl,
            () => parseThinking(_latestEditResponse).cleanedResponse,
            () => scrollToBottom()
        );
        const result = await editUserMessageAndRegenerate(currentThreadId, messageId, trimmedContent, (partialResponse, isComplete) => {
            _latestEditResponse = partialResponse;

            if (!streamingMsgEl) {
                refreshConversation();
                streamingMsgEl = document.querySelector('.sp-message-assistant:last-child .sp-message-content');
            }

            if (streamingMsgEl && streamingMsgEl.isConnected) {
                if (isComplete) {
                    editRenderer.cancel();
                    streamingMsgEl.innerHTML = renderMarkdown(parseThinking(partialResponse).cleanedResponse);
                    scrollToBottom();
                } else {
                    editRenderer.schedule();
                }
            }
        });
        editRenderer.cancel();
        succeeded = result.success === true;

        if (!result.success && !result.cancelled) {
            showToast(`Edit failed: ${result.error}`, 'error');
        }

        if (result.success) {
            playCompletionSound();
        }

        refreshConversation();
        scrollToBottom();

        const thread = getThread(currentThreadId);
        if (thread) {
            const titleEl = document.querySelector('.sp-thread-title');
            if (titleEl) {
                titleEl.textContent = thread.name;
            }
        }
    } finally {
        endGeneration(generationId);
        showGeneratingIndicator(false);
        advanceMessageQueue(threadId, succeeded);
    }
}

/**
 * Update a single message's swipe display in-place without full refresh
 * @param {string} messageId Message ID
 */
function updateSwipeDisplay(messageId) {
    if (!currentThreadId) return;
    const message = getMessage(currentThreadId, messageId);
    if (!message) return;

    const msgEl = document.querySelector(`.sp-message[data-message-id="${messageId}"]`);
    if (!msgEl) return;

    // Replace the entire message element to keep things simple and consistent
    const newMsgEl = createMessageElement(message);
    msgEl.replaceWith(newMsgEl);
}

/**
 * Handle swipe navigation (left/right)
 * @param {string} messageId Message ID
 * @param {number} direction -1 for left, 1 for right
 */
async function handleSwipeNavigation(messageId, direction) {
    if (!currentThreadId) return;

    const message = getMessage(currentThreadId, messageId);
    if (!message) return;

    ensureSwipeFields(message);
    const currentIdx = message.swipeId ?? 0;
    const newIdx = currentIdx + direction;

    // Left navigation
    if (direction === -1) {
        if (newIdx < 0) return;
        setActiveSwipe(currentThreadId, messageId, newIdx);
        await saveMetadata();
        updateSwipeDisplay(messageId);
        return;
    }

    // Right navigation
    if (newIdx < message.swipes.length) {
        // Navigate to existing swipe
        setActiveSwipe(currentThreadId, messageId, newIdx);
        await saveMetadata();
        updateSwipeDisplay(messageId);
        return;
    }

    // Past the end - generate new swipe
    await handleGenerateSwipe(messageId);
}

/**
 * Generate a new swipe with streaming
 * @param {string} messageId Message ID
 */
async function handleGenerateSwipe(messageId) {
    if (isGenerating() || !currentThreadId) return;

    const threadId = currentThreadId;
    const generationId = startGeneration();
    showGeneratingIndicator(true, handleCancelGeneration);

    // Disable swipe arrows during generation
    const msgEl = document.querySelector(`.sp-message[data-message-id="${messageId}"]`);
    if (msgEl) {
        msgEl.querySelectorAll('.sp-swipe-arrow').forEach(btn => btn.disabled = true);
    }

    let streamingContentEl = null;
    let succeeded = false;

    try {
        let _latestSwipeResponse = '';
        const swipeRenderer = createStreamingRenderer(
            () => streamingContentEl,
            () => parseThinking(_latestSwipeResponse).cleanedResponse,
            () => scrollToBottom()
        );
        const result = await generateSwipe(currentThreadId, messageId, (partialResponse, isComplete) => {
            _latestSwipeResponse = partialResponse;

            if (!streamingContentEl) {
                // Refresh to show the pending state
                updateSwipeDisplay(messageId);
                const updatedMsgEl = document.querySelector(`.sp-message[data-message-id="${messageId}"]`);
                if (updatedMsgEl) {
                    streamingContentEl = updatedMsgEl.querySelector('.sp-message-content');
                }
            }

            if (streamingContentEl && streamingContentEl.isConnected) {
                if (isComplete) {
                    // Render the final markdown once, after streaming completes
                    swipeRenderer.cancel();
                    streamingContentEl.innerHTML = renderMarkdown(parseThinking(partialResponse).cleanedResponse);
                    scrollToBottom();
                } else {
                    // Stream cheap plain text; markdown is rendered once on completion
                    swipeRenderer.schedule();
                }
            }
        });
        swipeRenderer.cancel();
        succeeded = result.success === true;

        if (!result.success && !result.cancelled) {
            showToast(`Swipe generation failed: ${result.error}`, 'error');
        }

        if (result.success) {
            playCompletionSound();
            // Best-effort incremental indexing for semantic search
            warmEmbeddings(result.response);
        }

        updateSwipeDisplay(messageId);

    } finally {
        endGeneration(generationId);
        showGeneratingIndicator(false);
        advanceMessageQueue(threadId, succeeded);
    }
}

/**
 * Handle deleting the current swipe
 * @param {string} messageId Message ID
 */
async function handleDeleteSwipe(messageId) {
    if (!currentThreadId) return;

    const message = getMessage(currentThreadId, messageId);
    if (!message || !message.swipes) return;

    // Don't allow deleting the last swipe
    if (message.swipes.length <= 1) {
        showToast('Cannot delete the only response', 'warning');
        return;
    }

    const result = deleteSwipe(currentThreadId, messageId, message.swipeId);
    if (result.empty) {
        showToast('Cannot delete the only response', 'warning');
        return;
    }

    await saveMetadata();
    updateSwipeDisplay(messageId);
}

/**
 * Handle sending a message. While a generation is running the message is
 * queued and sent once the reply ahead of it finishes.
 */
async function handleSendMessage() {
    const textarea = document.getElementById('sp-message-input');
    if (!textarea) return;

    const message = textarea.value.trim();
    if (!message) return;

    // Clear input
    textarea.value = '';
    textarea.style.height = 'auto';
    inputDraft = '';

    // Create thread if needed. Generation saves metadata right after adding
    // the first messages, so don't wait on a separate save here.
    let createdThread = false;
    if (!currentThreadId) {
        // Get context settings from the UI (which shows current global settings for new threads)
        const contextSettings = getContextSettingsFromUI();
        const newThread = createThread('New Thread', contextSettings);
        if (!newThread) {
            showToast('Failed to create thread', 'error');
            return;
        }
        currentThreadId = newThread.id;
        createdThread = true;
    }

    if (isGenerating()) {
        enqueueMessage(currentThreadId, message);
        if (createdThread) {
            // Swap the "New Thread" view for the real thread, and save it now
            // since no generation will touch it until the queue reaches it
            renderConversation(conversationContainer);
            await saveMetadata();
        } else {
            renderMessageQueue();
        }
        return;
    }

    await sendMessageToThread(currentThreadId, message);
}

/**
 * Send a message to a thread and stream the reply. Queued messages can be
 * dispatched while another thread (or no thread) is on screen, so the DOM is
 * only touched while this thread is being viewed.
 * @param {string} threadId Thread ID
 * @param {string} message Message text
 */
async function sendMessageToThread(threadId, message) {
    // Start generation and track ID
    const generationId = startGeneration();
    if (isViewingThread(threadId)) {
        showGeneratingIndicator(true, handleCancelGeneration);
    } else {
        updateSendButtonMode();
    }

    let succeeded = false;

    try {
        // Find the reply by ID rather than position: re-renders replace the
        // element, and the last message on screen may belong to another thread
        let pendingMessageId = null;
        let streamingMsgEl = null;
        const resolveStreamingElement = () => {
            if (!pendingMessageId || !isViewingThread(threadId)) return null;
            if (!streamingMsgEl?.isConnected) {
                refreshConversation();
                streamingMsgEl = conversationContainer.querySelector(
                    `.sp-message[data-message-id="${pendingMessageId}"] .sp-message-content`
                );
            }
            return streamingMsgEl;
        };

        let _latestStreamResponse = '';
        const streamRenderer = createStreamingRenderer(
            () => (isViewingThread(threadId) ? streamingMsgEl : null),
            () => parseThinking(_latestStreamResponse).cleanedResponse,
            () => scrollToBottom()
        );
        const generation = generateScratchPadResponse(message, threadId, (partialResponse, isComplete) => {
            _latestStreamResponse = partialResponse;

            const contentEl = resolveStreamingElement();
            if (!contentEl) return;

            if (isComplete) {
                // Render the final markdown once, after streaming completes
                streamRenderer.cancel();
                contentEl.innerHTML = renderMarkdown(parseThinking(partialResponse).cleanedResponse);
                scrollToBottom();
            } else {
                // Stream cheap plain text; markdown is rendered once on completion
                streamRenderer.schedule();
            }
        });
        // The user message and pending reply are stored before generation's first
        // await, so show them now instead of waiting for the first streamed token
        pendingMessageId = getPendingAssistantMessageId(threadId);
        if (resolveStreamingElement()) {
            scrollToBottom();
        }
        const result = await generation;
        streamRenderer.cancel();
        succeeded = result.success === true;

        if (!result.success && !result.cancelled) {
            showToast(`Failed to send message: ${result.error}`, 'error');
        }

        if (result.success) {
            playCompletionSound();
            // Best-effort incremental indexing for semantic search
            warmEmbeddings([message, result.response]);
        }

        if (isViewingThread(threadId)) {
            // Refresh conversation to show final state
            refreshConversation();
            // Ensure we scroll to show the new messages after refresh
            scrollToBottom();

            // Update thread name in header if changed
            const thread = getThread(threadId);
            const titleEl = conversationContainer.querySelector('.sp-thread-title');
            if (thread && titleEl) {
                titleEl.textContent = thread.name;
            }
        }

    } finally {
        endGeneration(generationId);
        showGeneratingIndicator(false);
        advanceMessageQueue(threadId, succeeded);
    }
}

/**
 * Continue the message queue after a generation settles. A queued message
 * waits on the reply ahead of it in its own thread, so when that reply is
 * cancelled or fails, the thread's queued messages go back to its input
 * instead of piling more turns on top.
 * @param {string|null} threadId Thread whose generation settled
 * @param {boolean} succeeded Whether the reply completed
 */
export function advanceMessageQueue(threadId, succeeded) {
    if (!succeeded && threadId) {
        const returned = takeQueuedMessages(threadId);
        if (returned.length > 0) {
            returnTextToInput(threadId, joinDraftText(...returned.map(entry => entry.content)));
            showToast(returned.length === 1
                ? 'Queued message returned to the input'
                : `${returned.length} queued messages returned to the input`, 'info');
        }
    }

    // Whatever is still generating will advance the queue when it finishes
    if (!isGenerating()) {
        let next = dequeueNextMessage();
        // Skip messages whose thread was deleted
        while (next && !getThread(next.threadId)) {
            next = dequeueNextMessage();
        }
        if (next) {
            sendMessageToThread(next.threadId, next.content).catch(error => {
                console.error('[ScratchPad] Queued message send error:', error);
            });
        }
    }

    renderMessageQueue();
    updateSendButtonMode();
}

/**
 * Drop queued messages and returned drafts; they belong to the previous chat's threads
 */
export function resetConversationQueue() {
    clearMessageQueue();
    returnedDrafts.clear();
    renderMessageQueue();
}

/**
 * Put text back into a thread's input, ahead of anything typed since
 * @param {string} threadId Thread ID
 * @param {string} text Text to return
 */
function returnTextToInput(threadId, text) {
    if (!text) return;

    if (!isViewingThread(threadId)) {
        returnedDrafts.set(threadId, joinDraftText(returnedDrafts.get(threadId), text));
        return;
    }

    const textarea = document.getElementById('sp-message-input');
    inputDraft = joinDraftText(text, textarea ? textarea.value : inputDraft);
    if (textarea) {
        textarea.value = inputDraft;
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    }
}

/**
 * Render the current thread's queued messages above the input
 */
function renderMessageQueue() {
    const inputContainer = conversationContainer?.querySelector('.sp-input-container');
    if (!inputContainer) return;

    inputContainer.querySelector('.sp-message-queue')?.remove();

    const queued = currentThreadId ? getQueuedMessages(currentThreadId) : [];
    if (queued.length === 0) return;

    const panel = document.createElement('div');
    panel.className = 'sp-message-queue';

    const header = document.createElement('div');
    header.className = 'sp-message-queue-header';
    const countEl = document.createElement('span');
    countEl.className = 'sp-message-queue-count';
    countEl.textContent = `Queued · ${queued.length}`;
    const hintEl = document.createElement('span');
    hintEl.className = 'sp-message-queue-hint';
    hintEl.textContent = queued.length === 1
        ? 'Sends when the current reply finishes'
        : 'Sends in order as each reply finishes';
    header.append(countEl, hintEl);
    panel.appendChild(header);

    queued.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'sp-queued-message';

        const textEl = document.createElement('span');
        textEl.className = 'sp-queued-message-text';
        textEl.textContent = entry.content;
        textEl.title = entry.content;
        row.appendChild(textEl);

        row.appendChild(createButton({
            icon: Icons.edit,
            className: 'sp-queued-edit-btn',
            ariaLabel: 'Edit queued message',
            onClick: () => {
                if (!removeQueuedMessage(entry.id)) return;
                returnTextToInput(entry.threadId, entry.content);
                renderMessageQueue();
                document.getElementById('sp-message-input')?.focus();
            }
        }));

        row.appendChild(createButton({
            icon: Icons.close,
            className: 'sp-queued-remove-btn',
            ariaLabel: 'Remove queued message',
            onClick: () => {
                removeQueuedMessage(entry.id);
                renderMessageQueue();
            }
        }));

        panel.appendChild(row);
    });

    inputContainer.insertBefore(panel, inputContainer.firstChild);
}

/**
 * Label the send button "Queue" while a generation is running
 */
function updateSendButtonMode() {
    const queueing = isGenerating();

    const sendBtn = document.getElementById('sp-send-btn');
    if (sendBtn) {
        const label = sendBtn.querySelector('.sp-button-text');
        if (label) label.textContent = queueing ? 'Queue' : 'Send';
        if (queueing) {
            sendBtn.title = 'Queue this message to send after the current reply';
        } else {
            sendBtn.removeAttribute('title');
        }
    }

    const textarea = document.getElementById('sp-message-input');
    if (textarea) {
        textarea.placeholder = queueing ? 'Queue a message...' : 'Ask a question...';
    }
}

/**
 * Cancel the active generation from the generating indicator
 */
function handleCancelGeneration() {
    cancelGeneration();
    showToast('Generation cancelled', 'info');
}

/**
 * Check whether a thread is the one currently shown in the conversation view
 * @param {string} threadId Thread ID
 * @returns {boolean} True if the thread is on screen
 */
function isViewingThread(threadId) {
    return !!threadId
        && currentThreadId === threadId
        && !!conversationContainer?.isConnected
        && conversationContainer.classList.contains('sp-conversation-view');
}

/**
 * Find the reply currently being generated in a thread
 * @param {string} threadId Thread ID
 * @returns {string|null} Pending assistant message ID
 */
function getPendingAssistantMessageId(threadId) {
    const thread = getThread(threadId);
    const pending = [...(thread?.messages || [])].reverse().find(message =>
        message.role === 'assistant' && message.status === 'pending'
    );
    return pending?.id ?? null;
}

/**
 * Handle retry of a failed message
 * @param {string} messageId Message ID
 */
async function handleRetry(messageId) {
    if (isGenerating() || !currentThreadId) return;

    const message = getMessage(currentThreadId, messageId);

    // For messages with swipes, use the swipe-based retry path in generation.js
    if (message?.swipes) {
        await handleGenerateSwipe(messageId);
        return;
    }

    // Start generation and track ID
    const threadId = currentThreadId;
    const generationId = startGeneration();
    showGeneratingIndicator(true, handleCancelGeneration);

    // Track the new assistant message ID for streaming updates
    let streamingMsgEl = null;
    let succeeded = false;

    try {
        let _latestRetryResponse = '';
        const retryRenderer = createStreamingRenderer(
            () => streamingMsgEl,
            () => parseThinking(_latestRetryResponse).cleanedResponse,
            () => scrollToBottom()
        );
        const result = await retryMessage(currentThreadId, messageId, (partialResponse, isComplete) => {
            _latestRetryResponse = partialResponse;

            // On first callback, refresh to show new pending message
            if (!streamingMsgEl) {
                refreshConversation();
                streamingMsgEl = document.querySelector('.sp-message-assistant:last-child .sp-message-content');
            }

            if (streamingMsgEl && streamingMsgEl.isConnected) {
                if (isComplete) {
                    // Render the final markdown once, after streaming completes
                    retryRenderer.cancel();
                    streamingMsgEl.innerHTML = renderMarkdown(parseThinking(partialResponse).cleanedResponse);
                    scrollToBottom();
                } else {
                    // Stream cheap plain text; markdown is rendered once on completion
                    retryRenderer.schedule();
                }
            }
        });
        retryRenderer.cancel();
        succeeded = result.success === true;

        if (!result.success && !result.cancelled) {
            showToast(`Retry failed: ${result.error}`, 'error');
        }

        if (result.success) {
            playCompletionSound();
        }

        refreshConversation();
        scrollToBottom();

    } finally {
        endGeneration(generationId);
        showGeneratingIndicator(false);
        advanceMessageQueue(threadId, succeeded);
    }
}

/**
 * Handle regenerating an assistant message (now generates a new swipe)
 * @param {string} messageId Message ID
 */
async function handleRegenerate(messageId) {
    await handleGenerateSwipe(messageId);
}

/**
 * Handle renaming the current thread
 * @param {Object} thread Thread object
 */
async function handleRenameThread(thread) {
    const newName = await showPromptDialog('Enter new thread name:', thread.name);

    if (newName && newName.trim() && newName.trim() !== thread.name) {
        updateThread(thread.id, { name: newName.trim() });
        await saveMetadata();

        const titleEl = document.querySelector('.sp-thread-title');
        if (titleEl) {
            titleEl.textContent = newName.trim();
        }

        showToast('Thread renamed', 'success');
    }
}

/**
 * Handle AI-assisted thread renaming
 * @param {Object} thread Thread object
 */
async function handleAiRename(thread) {
    if (!thread || !currentThreadId) return;

    try {
        // Show loading toast
        showToast('Generating title suggestion...', 'info');

        // Generate title. It holds the generation lock, so anything sent
        // meanwhile was queued behind it.
        const result = await generateThreadTitle(thread).finally(() => {
            advanceMessageQueue(null, true);
        });

        if (!result.success) {
            showToast(`Title generation failed: ${result.error}`, 'error');
            return;
        }

        // Show suggested title in a dialog for user to accept/edit
        const acceptedTitle = await showPromptDialog(
            'AI suggested title (you can edit it):',
            result.title
        );

        if (acceptedTitle && acceptedTitle.trim() && acceptedTitle.trim() !== thread.name) {
            updateThread(thread.id, { name: acceptedTitle.trim() });
            await saveMetadata();

            const titleEl = document.querySelector('.sp-thread-title');
            if (titleEl) {
                titleEl.textContent = acceptedTitle.trim();
            }

            showToast('Thread renamed', 'success');
        }
    } catch (error) {
        console.error('[ScratchPad] AI rename error:', error);
        showToast(`Title generation failed: ${error.message}`, 'error');
    }
}


/**
 * Go back to thread list
 */
function goBackToThreadList() {
    currentThreadId = null;
    removeViewportHandler();

    if (isFullscreenMode()) {
        // In fullscreen mode on mobile, show sidebar and hide main
        const sidebar = document.querySelector('.sp-fullscreen-sidebar');
        const main = document.querySelector('.sp-fullscreen-main');
        if (sidebar && main) {
            sidebar.classList.remove('sp-fs-hidden');
            main.classList.add('sp-fs-hidden');
        }
        // Show empty state in main
        const mainContent = document.querySelector('.sp-fullscreen-main .sp-drawer-content');
        if (mainContent) {
            mainContent.innerHTML = '';
            mainContent.className = 'sp-drawer-content';
            const empty = document.createElement('div');
            empty.className = 'sp-fullscreen-empty';
            empty.textContent = 'Select a thread or start a new conversation';
            mainContent.appendChild(empty);
        }
        // Refresh sidebar thread list
        import('./threadList.js').then(({ renderThreadList }) => {
            const sidebarContent = document.querySelector('.sp-fullscreen-sidebar .sp-drawer-content');
            if (sidebarContent) {
                renderThreadList(sidebarContent);
            }
        });
        return;
    }

    const drawer = document.getElementById('scratch-pad-drawer');
    if (!drawer) return;

    const content = drawer.querySelector('.sp-drawer-content');
    if (!content) return;

    import('./threadList.js').then(({ renderThreadList }) => {
        renderThreadList(content);
    });
}

/**
 * Refresh the conversation view
 * Skips re-render if the thread ID, message count, and last message status
 * haven't changed. Tracking the last message ID keeps retry failures that
 * replace failed messages from leaving stale retry buttons in the DOM.
 */
function refreshConversation() {
    if (!conversationContainer || !currentThreadId) return;

    const thread = getThreadForCurrentBranch(currentThreadId);
    const currentCount = thread ? thread.messages.length : 0;
    const lastMsg = thread?.messages?.[thread.messages.length - 1];
    const currentStatus = lastMsg?.status ?? null;
    const currentMessageId = lastMsg?.id ?? null;

    // Skip expensive full re-render if nothing has changed
    if (
        currentThreadId === lastRenderedThreadId &&
        currentCount === lastRenderedMessageCount &&
        currentStatus === lastRenderedMessageStatus &&
        currentMessageId === lastRenderedMessageId
    ) {
        return;
    }

    renderConversation(conversationContainer);
}

/**
 * Update the open conversation with a generation that started in the quick popup.
 * @param {string} threadId Thread receiving the generation
 * @param {string} partialResponse Current streamed response
 * @param {boolean} isComplete Whether the stream has completed
 */
export function updateTransferredGeneration(threadId, partialResponse, isComplete = false) {
    if (currentThreadId !== threadId || !conversationContainer?.isConnected) return;

    const pendingMessageId = getPendingAssistantMessageId(threadId);
    if (!pendingMessageId) return;

    const contentEl = conversationContainer.querySelector(
        `.sp-message[data-message-id="${pendingMessageId}"] .sp-message-content`
    );
    if (!contentEl) return;

    const cleanedResponse = parseThinking(partialResponse).cleanedResponse;
    if (isComplete) {
        contentEl.innerHTML = renderMarkdown(cleanedResponse);
    } else {
        contentEl.textContent = cleanedResponse;
    }
    scrollToBottom();
}

/**
 * Refresh a conversation after a generation transferred from the quick popup.
 * @param {string} threadId Thread that finished generating
 */
export function finishTransferredGeneration(threadId) {
    if (currentThreadId !== threadId || !conversationContainer?.isConnected) return;

    renderConversation(conversationContainer);
    scrollToBottom();
}

/**
 * Load all messages (for large threads)
 * @param {Object} thread Thread object
 */
function loadAllMessages(thread) {
    const messagesContainer = document.getElementById('sp-messages');
    if (!messagesContainer) return;

    messagesContainer.innerHTML = '';

    thread.messages.forEach(msg => {
        const msgEl = createMessageElement(msg);
        messagesContainer.appendChild(msgEl);
    });

    scrollToBottom();
}

/**
 * Scroll messages to bottom
 * Uses multiple techniques for reliable mobile scrolling
 */
let _scrollPending = false;
let _scrollContainer = null;
function scrollToBottom() {
    if (_scrollPending) return;
    _scrollPending = true;
    requestAnimationFrame(() => {
        _scrollPending = false;
        if (!_scrollContainer || !_scrollContainer.isConnected) {
            _scrollContainer = document.getElementById('sp-messages');
        }
        if (_scrollContainer) {
            _scrollContainer.scrollTop = _scrollContainer.scrollHeight;
        }
    });
}

/**
 * Remove viewport resize handler if one exists
 */
function removeViewportHandler() {
    if (currentViewportBusUnsubscribe) {
        currentViewportBusUnsubscribe();
        currentViewportBusUnsubscribe = null;
    }
    if (currentViewportHandler && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', currentViewportHandler);
    }
    currentViewportHandler = null;
    // Reset container height when keyboard handler is removed
    const container = document.querySelector('.sp-drawer') || document.querySelector('.sp-fullscreen');
    if (container) {
        container.style.removeProperty('height');
    }
}

/**
 * Close the scratch pad drawer
 */
async function closeScratchPadDrawer() {
    currentThreadId = null;
    removeViewportHandler();
    const { closeScratchPad } = await import('./index.js');
    closeScratchPad();
}

/**
 * Setup viewport handlers for keyboard
 */
function setupViewportHandlers() {
    // Remove old handler if exists
    removeViewportHandler();

    const runtimeBus = window.STRuntimeBus;
    if (!window.visualViewport && !runtimeBus?.viewport?.subscribe) {
        return;
    }

    // Cache container reference and last height to avoid redundant DOM updates
    let cachedContainer = document.querySelector('.sp-drawer') || document.querySelector('.sp-fullscreen');
    let lastHeight = 0;
    let viewportRafPending = false;

    // Create and store new handler - coalesce with rAF instead of debounce
    // to avoid firing multiple times during keyboard animation
    currentViewportHandler = () => {
        if (viewportRafPending) return;
        viewportRafPending = true;
        requestAnimationFrame(() => {
            viewportRafPending = false;
            const viewportHeight = window.visualViewport?.height ?? window.innerHeight;

            // Only update DOM if height changed significantly (>10px avoids sub-pixel noise)
            if (Math.abs(viewportHeight - lastHeight) <= 10) return;
            lastHeight = viewportHeight;

            // Re-query only if cached reference is stale
            if (!cachedContainer || !cachedContainer.isConnected) {
                cachedContainer = document.querySelector('.sp-drawer') || document.querySelector('.sp-fullscreen');
            }

            // Resize the drawer/fullscreen container to match the visual viewport,
            // so the flex layout naturally adjusts the messages area for the keyboard
            if (cachedContainer) {
                cachedContainer.style.setProperty('height', `${viewportHeight}px`, 'important');
            }
            scrollToBottom();
        });
    };

    if (runtimeBus?.viewport?.subscribe) {
        currentViewportBusUnsubscribe = runtimeBus.viewport.subscribe('keyboard', currentViewportHandler);
    } else if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', currentViewportHandler);
    }
}

/**
 * Show or hide the generating indicator
 * @param {boolean} show Whether to show the indicator
 * @param {Function} onCancel Optional callback when cancel is clicked
 */
function showGeneratingIndicator(show, onCancel = null) {
    const inputContainer = document.querySelector('.sp-input-container');
    if (!inputContainer) return;

    // Remove existing indicator
    const existing = inputContainer.querySelector('.sp-generating-indicator');
    if (existing) existing.remove();

    if (show) {
        const indicator = document.createElement('div');
        indicator.className = 'sp-generating-indicator';

        const spinnerSpan = document.createElement('div');
        spinnerSpan.className = 'sp-generating-spinner';
        indicator.appendChild(spinnerSpan);

        const textSpan = document.createElement('span');
        textSpan.textContent = 'Generating response...';
        indicator.appendChild(textSpan);

        if (onCancel) {
            const cancelBtn = createButton({
                icon: Icons.cancel,
                text: 'Cancel',
                className: 'sp-cancel-btn',
                onClick: onCancel
            });
            indicator.appendChild(cancelBtn);
        }

        // Keep the indicator directly above the input: the queue panel above it
        // changes height as items leave, and must not shift Cancel under the pointer
        inputContainer.insertBefore(indicator, inputContainer.querySelector('.sp-input-wrapper'));
        inputContainer.classList.add('sp-generating');
    } else {
        inputContainer.classList.remove('sp-generating');
    }
    updateSendButtonMode();
}

/**
 * Get current thread ID
 * @returns {string|null} Current thread ID
 */
export function getCurrentThreadId() {
    return currentThreadId;
}
