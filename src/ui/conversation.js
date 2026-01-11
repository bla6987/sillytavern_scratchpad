/**
 * Conversation View component for Scratch Pad extension
 */

import { getThread, updateThread, saveMetadata } from '../storage.js';
import { generateScratchPadResponse, retryMessage } from '../generation.js';
import { formatTimestamp, renderMarkdown, createButton, showPromptDialog, showToast, createSpinner, debounce, Icons } from './components.js';

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
    const roleEl = document.createElement('div');
    roleEl.className = 'sp-message-role';
    roleEl.textContent = message.role === 'user' ? 'You' : 'Assistant';
    msgEl.appendChild(roleEl);

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
        contentEl.innerHTML = renderMarkdown(message.content);
    }

    msgEl.appendChild(contentEl);

    // Timestamp
    const timeEl = document.createElement('div');
    timeEl.className = 'sp-message-time';
    timeEl.textContent = formatTimestamp(message.timestamp);
    msgEl.appendChild(timeEl);

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

    // Disable send
    isGenerating = true;
    if (sendBtn) sendBtn.disabled = true;

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
                    streamingMsgEl.innerHTML = renderMarkdown(partialResponse);
                }
                scrollToBottom();
            }
        });

        if (!result.success) {
            showToast(`Error: ${result.error}`, 'error');
        }

        // Refresh conversation to show final state
        refreshConversation();

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
    isGenerating = true;
    if (sendBtn) sendBtn.disabled = true;

    try {
        const result = await retryMessage(currentThreadId, messageId, (partialResponse, isComplete) => {
            const msgEl = document.querySelector(`[data-message-id="${messageId}"] .sp-message-content`);
            if (msgEl && !isComplete) {
                msgEl.innerHTML = renderMarkdown(partialResponse);
            }
            scrollToBottom();
        });

        if (!result.success) {
            showToast(`Retry failed: ${result.error}`, 'error');
        }

        refreshConversation();

    } finally {
        isGenerating = false;
        if (sendBtn) sendBtn.disabled = false;
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
 */
function scrollToBottom() {
    const messagesContainer = document.getElementById('sp-messages');
    if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
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
 * Get current thread ID
 * @returns {string|null} Current thread ID
 */
export function getCurrentThreadId() {
    return currentThreadId;
}
