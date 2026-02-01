/**
 * Conversation View component for Scratch Pad extension
 */

import { getThread, updateThread, saveMetadata } from '../storage.js';
import { generateScratchPadResponse, retryMessage, parseThinking, generateThreadTitle, cancelGeneration } from '../generation.js';
import { formatTimestamp, renderMarkdown, createButton, showPromptDialog, showToast, createSpinner, debounce, Icons } from './components.js';
import { speakText, isTTSAvailable } from '../tts.js';
import { getSettings } from '../settings.js';
import { isPinnedMode, togglePinnedMode } from './index.js';

let conversationContainer = null;
let currentThreadId = null;
let isGenerating = false;
let pendingMessage = null;

/**
 * Open a thread in conversation view
 * @param {string} threadId Thread ID
 * @param {string} [initialMessage] Optional message to send immediately
 */
export function openThread(threadId, initialMessage = null) {
    console.log('[ScratchPad Conv] openThread called:', threadId, initialMessage);
    currentThreadId = threadId;
    pendingMessage = initialMessage;

    const drawer = document.getElementById('scratch-pad-drawer');
    console.log('[ScratchPad Conv] drawer element:', drawer);
    if (!drawer) {
        console.error('[ScratchPad Conv] drawer not found!');
        return;
    }

    const content = drawer.querySelector('.sp-drawer-content');
    console.log('[ScratchPad Conv] content element:', content);
    if (!content) {
        console.error('[ScratchPad Conv] content not found!');
        return;
    }

    console.log('[ScratchPad Conv] calling renderConversation...');
    renderConversation(content);
}

/**
 * Start a new thread (empty conversation view)
 */
export function startNewThread() {
    console.log('[ScratchPad Conv] startNewThread called');
    currentThreadId = null;
    pendingMessage = null;

    const drawer = document.getElementById('scratch-pad-drawer');
    console.log('[ScratchPad Conv] drawer element:', drawer);
    if (!drawer) {
        console.error('[ScratchPad Conv] drawer not found!');
        return;
    }

    const content = drawer.querySelector('.sp-drawer-content');
    console.log('[ScratchPad Conv] content element:', content);
    if (!content) {
        console.error('[ScratchPad Conv] content not found!');
        return;
    }

    console.log('[ScratchPad Conv] calling renderConversation(true)...');
    renderConversation(content, true);
}

/**
 * Render the conversation view
 * @param {HTMLElement} container Container element
 * @param {boolean} isNewThread Whether this is a new thread
 */
export function renderConversation(container, isNewThread = false) {
    console.log('[ScratchPad Conv] renderConversation called, isNewThread:', isNewThread, 'currentThreadId:', currentThreadId);
    conversationContainer = container;

    const thread = currentThreadId ? getThread(currentThreadId) : null;

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
    } else if (!isNewThread && thread) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sp-empty-state';
        emptyState.innerHTML = `<p>No messages yet. Ask a question below.</p>`;
        messagesContainer.appendChild(emptyState);
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

    // Auto-resize textarea
    textarea.addEventListener('input', debounce(() => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
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

    // Content
    const contentEl = document.createElement('div');
    contentEl.className = 'sp-message-content';

    if (message.status === 'pending') {
        contentEl.appendChild(createSpinner());
    } else if (message.status === 'failed') {
        contentEl.innerHTML = `
            <div class="sp-error-message">
                <span class="sp-error-icon">${Icons.error}</span>
                <span>Generation failed${message.error ? `: ${message.error}` : ''}</span>
            </div>
        `;

        const retryBtn = createButton({
            icon: Icons.retry,
            text: 'Retry',
            className: 'sp-retry-btn',
            onClick: () => handleRetry(message.id)
        });
        contentEl.appendChild(retryBtn);
    } else {
        // Render thinking section if present (collapsible)
        if (message.thinking && message.role === 'assistant') {
            const thinkingEl = document.createElement('details');
            thinkingEl.className = 'sp-thinking';
            thinkingEl.innerHTML = `
                <summary>💭 Model Thinking</summary>
                <div class="sp-thinking-content">${renderMarkdown(message.thinking)}</div>
            `;
            contentEl.appendChild(thinkingEl);
        }

        // Render main content
        const mainContent = document.createElement('div');
        mainContent.innerHTML = renderMarkdown(message.content);
        contentEl.appendChild(mainContent);
    }

    msgEl.appendChild(contentEl);

    // Message footer with timestamp and actions
    const footerEl = document.createElement('div');
    footerEl.className = 'sp-message-footer';

    // Timestamp
    const timeEl = document.createElement('div');
    timeEl.className = 'sp-message-time';
    timeEl.textContent = formatTimestamp(message.timestamp);
    footerEl.appendChild(timeEl);

    // Actions for assistant messages
    if (message.role === 'assistant' && message.status === 'complete' && message.content) {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'sp-message-actions';

        // TTS speak button (only if TTS is enabled)
        if (isTTSAvailable()) {
            const speakBtn = createButton({
                icon: Icons.speak,
                className: 'sp-speak-btn',
                ariaLabel: 'Speak this message',
                onClick: async () => {
                    speakBtn.disabled = true;
                    speakBtn.classList.add('sp-speaking');
                    try {
                        const success = await speakText(message.content);
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
 * Handle sending a message
 */
async function handleSendMessage() {
    if (isGenerating) return;

    const textarea = document.getElementById('sp-message-input');
    const sendBtn = document.getElementById('sp-send-btn');
    if (!textarea) return;

    const message = textarea.value.trim();
    if (!message) return;

    // Clear input
    textarea.value = '';
    textarea.style.height = 'auto';

    // Disable send and show generating indicator with cancel button
    isGenerating = true;
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
            const { createThread } = await import('../storage.js');
            const newThread = createThread('New Thread');
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

            if (streamingMsgEl) {
                if (!isComplete) {
                    // Parse out thinking tags during streaming so they don't appear as raw markdown
                    const { cleanedResponse } = parseThinking(partialResponse);
                    streamingMsgEl.innerHTML = renderMarkdown(cleanedResponse);
                }
                scrollToBottom();
            }
        });

        if (!result.success && !result.cancelled) {
            showToast(`Error: ${result.error}`, 'error');
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
        isGenerating = false;
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
    if (isGenerating || !currentThreadId) return;

    const sendBtn = document.getElementById('sp-send-btn');
    const textarea = document.getElementById('sp-message-input');

    // Show generating state in UI with cancel button
    isGenerating = true;
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

            if (streamingMsgEl && !isComplete) {
                // Parse out thinking tags during streaming so they don't appear as raw markdown
                const { cleanedResponse } = parseThinking(partialResponse);
                streamingMsgEl.innerHTML = renderMarkdown(cleanedResponse);
            }
            scrollToBottom();
        });

        if (!result.success && !result.cancelled) {
            showToast(`Retry failed: ${result.error}`, 'error');
        }

        refreshConversation();
        scrollToBottom();

    } finally {
        isGenerating = false;
        if (sendBtn) sendBtn.disabled = false;
        if (textarea) {
            textarea.disabled = false;
            textarea.placeholder = 'Ask a question...';
        }
        showGeneratingIndicator(false);
    }
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
            showToast(`Error: ${result.error}`, 'error');
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
        showToast(`Error: ${error.message}`, 'error');
    }
}


/**
 * Go back to thread list
 */
function goBackToThreadList() {
    currentThreadId = null;

    const drawer = document.getElementById('scratch-pad-drawer');
    if (!drawer) return;

    const content = drawer.querySelector('.sp-drawer-content');
    if (!content) return;

    // Import dynamically to avoid circular dependency
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
 * Close the scratch pad drawer
 */
async function closeScratchPadDrawer() {
    currentThreadId = null;
    const { closeScratchPad } = await import('./index.js');
    closeScratchPad();
}

/**
 * Setup viewport handlers for keyboard
 */
function setupViewportHandlers() {
    if (window.visualViewport) {
        const handleResize = debounce(() => {
            const inputContainer = document.querySelector('.sp-input-container');
            if (inputContainer) {
                const viewportHeight = window.visualViewport.height;
                const windowHeight = window.innerHeight;
                const keyboardHeight = windowHeight - viewportHeight;

                if (keyboardHeight > 0) {
                    inputContainer.style.bottom = `${keyboardHeight}px`;
                } else {
                    inputContainer.style.bottom = '0';
                }
            }
            scrollToBottom();
        }, 50);

        window.visualViewport.addEventListener('resize', handleResize);
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
