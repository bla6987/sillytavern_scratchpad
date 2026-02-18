/**
 * Conversation View component for Scratch Pad extension
 */

import { getThread, getThreadForCurrentBranch, createThread, updateThread, updateThreadContextSettings, getThreadContextSettings, getMessage, saveMetadata, DEFAULT_CONTEXT_SETTINGS, ensureSwipeFields, setActiveSwipe, deleteSwipe, syncSwipeToMessage } from '../storage.js';
import { generateScratchPadResponse, retryMessage, regenerateMessage, generateSwipe, parseThinking, generateThreadTitle, cancelGeneration, isGuidedGenerationsInstalled, triggerGuidedSwipe } from '../generation.js';
import { formatTimestamp, renderMarkdown, createButton, showPromptDialog, showConfirmDialog, showToast, createSpinner, debounce, Icons, playCompletionSound } from './components.js';
import { speakText, isTTSAvailable } from '../tts.js';
import { getSettings, getCurrentContextSettings, getConnectionProfiles } from '../settings.js';
import { isPinnedMode, togglePinnedMode, isFullscreenMode, getConversationContainer } from './index.js';
import { REASONING_STATE, normalizeReasoningMeta } from '../reasoning.js';

let conversationContainer = null;
let currentThreadId = null;
let activeGenerationId = null;
let pendingMessage = null;
let cleanupFunctions = [];
let currentViewportHandler = null;

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
    return activeGenerationId !== null;
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

    // Scroll to bottom
    scrollToBottom();

    // Focus input
    setTimeout(() => {
        textarea.focus();

        // Handle pending message
        if (pendingMessage) {
            textarea.value = pendingMessage;
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
    profileBadge.style.display = contextSettings.connectionProfile ? 'inline-block' : 'none';
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

    optionsBlock.innerHTML = `
        <label for="${idPrefix}connection_profile">
            <span>Connection Profile:</span>
            <small>Override which API profile to use for this thread.</small>
        </label>
        <div class="range-block">
            <select id="${idPrefix}connection_profile" class="text_pole">
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
    populateThreadProfileDropdown(contextSettings.connectionProfile, idPrefix);
}

/**
 * Get badge text for profile override
 * @param {Object} contextSettings Context settings object
 * @returns {string} Profile badge text
 */
function getProfileBadgeText(contextSettings) {
    if (contextSettings.connectionProfile) {
        return contextSettings.connectionProfile;
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

    const profile = profileSelect.value;
    if (profile) {
        profileBadge.textContent = profile;
        profileBadge.style.display = 'inline-block';
    } else {
        profileBadge.style.display = 'none';
    }
}

/**
 * Populate the thread profile dropdown with available profiles
 * @param {string|null} currentProfile Currently selected profile
 * @param {string} idPrefix ID prefix for elements
 */
async function populateThreadProfileDropdown(currentProfile, idPrefix) {
    const profileSelect = document.getElementById(`${idPrefix}connection_profile`);
    if (!profileSelect) return;

    const profiles = await getConnectionProfiles();

    // Keep the "Use Global Setting" option, add profiles
    profileSelect.innerHTML = '<option value="">Use Global Setting</option>';
    profiles.forEach(profile => {
        const option = document.createElement('option');
        option.value = profile;
        option.textContent = profile;
        profileSelect.appendChild(option);
    });

    // Restore selected value
    if (currentProfile) {
        profileSelect.value = currentProfile;
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
            const profile = e.target.value || null;
            updateContextSetting('connectionProfile', profile);
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
        connectionProfile: profileSelect?.value || null,
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
        if (!hasSwipes && message.status === 'complete' && message.content) {
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

    // Timestamp
    const timeEl = document.createElement('div');
    timeEl.className = 'sp-message-time';
    timeEl.textContent = formatTimestamp(message.timestamp);
    footerEl.appendChild(timeEl);

    // Actions for assistant messages
    if (isAssistant && message.status === 'complete' && message.content) {
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
                    await navigator.clipboard.writeText(content);
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
    }

    msgEl.appendChild(footerEl);

    return msgEl;
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

    const sendBtn = document.getElementById('sp-send-btn');
    const textarea = document.getElementById('sp-message-input');

    const generationId = startGeneration();
    if (sendBtn) sendBtn.disabled = true;
    if (textarea) {
        textarea.disabled = true;
        textarea.placeholder = 'Generating swipe...';
    }
    showGeneratingIndicator(true, () => {
        cancelGeneration();
        showToast('Generation cancelled', 'info');
    });

    // Disable swipe arrows during generation
    const msgEl = document.querySelector(`.sp-message[data-message-id="${messageId}"]`);
    if (msgEl) {
        msgEl.querySelectorAll('.sp-swipe-arrow').forEach(btn => btn.disabled = true);
    }

    let streamingContentEl = null;

    try {
        const result = await generateSwipe(currentThreadId, messageId, (partialResponse, isComplete) => {
            if (!streamingContentEl) {
                // Refresh to show the pending state
                updateSwipeDisplay(messageId);
                const updatedMsgEl = document.querySelector(`.sp-message[data-message-id="${messageId}"]`);
                if (updatedMsgEl) {
                    streamingContentEl = updatedMsgEl.querySelector('.sp-message-content');
                }
            }

            if (streamingContentEl && streamingContentEl.isConnected && !isComplete) {
                const { cleanedResponse } = parseThinking(partialResponse);
                streamingContentEl.innerHTML = renderMarkdown(cleanedResponse);
                scrollToBottom();
            }
        });

        if (!result.success && !result.cancelled) {
            showToast(`Swipe generation failed: ${result.error}`, 'error');
        }

        if (result.success) {
            playCompletionSound();
        }

        updateSwipeDisplay(messageId);

    } finally {
        endGeneration(generationId);
        if (sendBtn) sendBtn.disabled = false;
        if (textarea) {
            textarea.disabled = false;
            textarea.placeholder = 'Ask a question...';
        }
        showGeneratingIndicator(false);
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
 * Handle sending a message
 */
async function handleSendMessage() {
    if (isGenerating()) return;

    const textarea = document.getElementById('sp-message-input');
    const sendBtn = document.getElementById('sp-send-btn');
    if (!textarea) return;

    const message = textarea.value.trim();
    if (!message) return;

    // Clear input
    textarea.value = '';
    textarea.style.height = 'auto';

    // Start generation and track ID
    const generationId = startGeneration();
    if (sendBtn) sendBtn.disabled = true;
    textarea.disabled = true;
    textarea.placeholder = 'Generating...';
    showGeneratingIndicator(true, () => {
        cancelGeneration();
        showToast('Generation cancelled', 'info');
    });

    try {
        // Create thread if needed
        if (!currentThreadId) {
            // Get context settings from the UI (which shows current global settings for new threads)
            const contextSettings = getContextSettingsFromUI();
            const newThread = createThread('New Thread', contextSettings);
            if (!newThread) {
                showToast('Failed to create thread', 'error');
                return;
            }
            currentThreadId = newThread.id;
            await saveMetadata();
        }

        // Refresh UI to show user message immediately
        const messagesContainer = document.getElementById('sp-messages');
        if (messagesContainer) {
            // Clear empty state
            const emptyState = messagesContainer.querySelector('.sp-empty-state');
            if (emptyState) {
                emptyState.remove();
            }
        }

        // Generate response with streaming
        let streamingMsgEl = null;

        const result = await generateScratchPadResponse(message, currentThreadId, (partialResponse, isComplete) => {
            // Update streaming message element
            if (!streamingMsgEl) {
                // Refresh to show user message and pending assistant message
                refreshConversation();
                streamingMsgEl = document.querySelector('.sp-message-assistant:last-child .sp-message-content');
            }

            if (streamingMsgEl && streamingMsgEl.isConnected) {
                if (!isComplete) {
                    // Parse out thinking tags during streaming so they don't appear as raw markdown
                    const { cleanedResponse } = parseThinking(partialResponse);
                    streamingMsgEl.innerHTML = renderMarkdown(cleanedResponse);
                }
                scrollToBottom();
            }
        });

        if (!result.success && !result.cancelled) {
            showToast(`Failed to send message: ${result.error}`, 'error');
        }

        if (result.success) {
            playCompletionSound();
        }

        // Refresh conversation to show final state
        refreshConversation();
        // Ensure we scroll to show the new messages after refresh
        scrollToBottom();

        // Update thread name in header if changed
        const thread = getThread(currentThreadId);
        if (thread) {
            const titleEl = document.querySelector('.sp-thread-title');
            if (titleEl) {
                titleEl.textContent = thread.name;
            }
        }

    } finally {
        endGeneration(generationId);
        if (sendBtn) sendBtn.disabled = false;
        textarea.disabled = false;
        textarea.placeholder = 'Ask a question...';
        showGeneratingIndicator(false);
        textarea.focus();
    }
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

    const sendBtn = document.getElementById('sp-send-btn');
    const textarea = document.getElementById('sp-message-input');

    // Start generation and track ID
    const generationId = startGeneration();
    if (sendBtn) sendBtn.disabled = true;
    if (textarea) {
        textarea.disabled = true;
        textarea.placeholder = 'Generating...';
    }
    showGeneratingIndicator(true, () => {
        cancelGeneration();
        showToast('Generation cancelled', 'info');
    });

    // Track the new assistant message ID for streaming updates
    let streamingMsgEl = null;

    try {
        const result = await retryMessage(currentThreadId, messageId, (partialResponse, isComplete) => {
            // On first callback, refresh to show new pending message
            if (!streamingMsgEl) {
                refreshConversation();
                streamingMsgEl = document.querySelector('.sp-message-assistant:last-child .sp-message-content');
            }

            if (streamingMsgEl && streamingMsgEl.isConnected && !isComplete) {
                // Parse out thinking tags during streaming so they don't appear as raw markdown
                const { cleanedResponse } = parseThinking(partialResponse);
                streamingMsgEl.innerHTML = renderMarkdown(cleanedResponse);
            }
            scrollToBottom();
        });

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
        if (sendBtn) sendBtn.disabled = false;
        if (textarea) {
            textarea.disabled = false;
            textarea.placeholder = 'Ask a question...';
        }
        showGeneratingIndicator(false);
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

        // Generate title
        const result = await generateThreadTitle(thread);

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
 */
function refreshConversation() {
    if (conversationContainer && currentThreadId) {
        renderConversation(conversationContainer);
    }
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
function scrollToBottom() {
    // Use requestAnimationFrame + setTimeout to ensure DOM has fully laid out
    requestAnimationFrame(() => {
        setTimeout(() => {
            const messagesContainer = document.getElementById('sp-messages');
            if (messagesContainer) {
                // Try scrollIntoView on last message for better mobile support
                const lastMessage = messagesContainer.querySelector('.sp-message:last-child');
                if (lastMessage) {
                    lastMessage.scrollIntoView({ behavior: 'auto', block: 'end' });
                } else {
                    // Fallback to scrollTop
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                }
            }
        }, 50); // Small delay to ensure layout is complete
    });
}

/**
 * Remove viewport resize handler if one exists
 */
function removeViewportHandler() {
    if (currentViewportHandler && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', currentViewportHandler);
        currentViewportHandler = null;
    }
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
    if (window.visualViewport) {
        // Remove old handler if exists
        removeViewportHandler();

        // Create and store new handler
        currentViewportHandler = debounce(() => {
            const viewportHeight = window.visualViewport.height;
            // Resize the drawer/fullscreen container to match the visual viewport,
            // so the flex layout naturally adjusts the messages area for the keyboard
            const container = document.querySelector('.sp-drawer') || document.querySelector('.sp-fullscreen');
            if (container) {
                container.style.setProperty('height', `${viewportHeight}px`, 'important');
            }
            scrollToBottom();
        }, 50);

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

        inputContainer.insertBefore(indicator, inputContainer.firstChild);
        inputContainer.classList.add('sp-generating');
    } else {
        inputContainer.classList.remove('sp-generating');
    }
}

/**
 * Get current thread ID
 * @returns {string|null} Current thread ID
 */
export function getCurrentThreadId() {
    return currentThreadId;
}
