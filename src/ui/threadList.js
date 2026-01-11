/**
 * Thread List View component for Scratch Pad extension
 */

import { getThreads, createThread, deleteThread, updateThread, saveMetadata } from '../storage.js';
import { formatTimestamp, truncateText, createButton, showConfirmDialog, showPromptDialog, showToast, Icons } from './components.js';

// Dynamic import to avoid circular dependency
let conversationModule = null;
async function getConversationModule() {
    console.log('[ScratchPad] getConversationModule called, cached:', !!conversationModule);
    if (!conversationModule) {
        try {
            conversationModule = await import('./conversation.js');
            console.log('[ScratchPad] Loaded conversation module:', Object.keys(conversationModule));
        } catch (err) {
            console.error('[ScratchPad] Failed to load conversation module:', err);
            throw err;
        }
    }
    return conversationModule;
}

let threadListContainer = null;

/**
 * Render the thread list view
 * @param {HTMLElement} container Container element
 */
export function renderThreadList(container) {
    console.log('[ScratchPad UI] Rendering thread list');
    threadListContainer = container;

    container.innerHTML = '';
    // Preserve sp-drawer-content class while adding view-specific class
    container.className = 'sp-drawer-content sp-thread-list-view';

    // Header
    const header = document.createElement('div');
    header.className = 'sp-header';

    const titleContainer = document.createElement('div');
    titleContainer.className = 'sp-title-container';

    const titleEl = document.createElement('h2');
    titleEl.className = 'sp-title';
    titleEl.textContent = 'Scratch Pad';
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

    // Action bar
    const actionBar = document.createElement('div');
    actionBar.className = 'sp-action-bar';

    const newThreadBtn = createButton({
        icon: Icons.add,
        text: 'New Thread',
        className: 'sp-new-thread-btn',
        onClick: () => handleNewThread()
    });
    actionBar.appendChild(newThreadBtn);
    container.appendChild(actionBar);

    // Thread list
    const listContainer = document.createElement('div');
    listContainer.className = 'sp-thread-list';
    listContainer.id = 'sp-thread-list';

    const threads = getThreads();

    if (threads.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sp-empty-state';
        emptyState.innerHTML = `
            <div class="sp-empty-icon">${Icons.thread}</div>
            <p>No threads yet.</p>
            <p>Start a conversation to create one.</p>
        `;
        listContainer.appendChild(emptyState);
    } else {
        threads.forEach(thread => {
            const threadItem = createThreadItem(thread);
            listContainer.appendChild(threadItem);
        });
    }

    container.appendChild(listContainer);

    // Quick input at bottom
    const inputContainer = document.createElement('div');
    inputContainer.className = 'sp-quick-input-container';

    const quickInput = document.createElement('textarea');
    quickInput.className = 'sp-quick-input';
    quickInput.placeholder = 'Ask a question to start a new thread...';
    quickInput.rows = 2;

    const sendBtn = createButton({
        icon: Icons.send,
        text: 'Send',
        className: 'sp-send-btn',
        onClick: () => handleQuickSend(quickInput.value)
    });

    quickInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleQuickSend(quickInput.value).catch(err => {
                console.error('[ScratchPad] Quick send error:', err);
            });
        }
    });

    inputContainer.appendChild(quickInput);
    inputContainer.appendChild(sendBtn);
    container.appendChild(inputContainer);
}

/**
 * Create a thread list item element
 * @param {Object} thread Thread object
 * @returns {HTMLElement} Thread item element
 */
function createThreadItem(thread) {
    const item = document.createElement('div');
    item.className = 'sp-thread-item';
    item.dataset.threadId = thread.id;

    // Main clickable area
    const mainContent = document.createElement('div');
    mainContent.className = 'sp-thread-main';
    mainContent.addEventListener('click', async () => {
        console.log('[ScratchPad] Thread clicked:', thread.id, thread.name);
        try {
            const { openThread } = await getConversationModule();
            console.log('[ScratchPad] Got openThread function, calling...');
            openThread(thread.id);
            console.log('[ScratchPad] openThread called successfully');
        } catch (err) {
            console.error('[ScratchPad] Error opening thread:', err);
        }
    });

    // Thread name
    const nameEl = document.createElement('div');
    nameEl.className = 'sp-thread-name';
    nameEl.textContent = thread.name;
    mainContent.appendChild(nameEl);

    // Preview of last message
    const lastMessage = thread.messages[thread.messages.length - 1];
    if (lastMessage) {
        const previewEl = document.createElement('div');
        previewEl.className = 'sp-thread-preview';
        previewEl.textContent = truncateText(lastMessage.content, 60);
        mainContent.appendChild(previewEl);
    }

    // Timestamp
    const timeEl = document.createElement('div');
    timeEl.className = 'sp-thread-time';
    timeEl.textContent = formatTimestamp(thread.updatedAt);
    mainContent.appendChild(timeEl);

    item.appendChild(mainContent);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'sp-thread-actions';

    const renameBtn = createButton({
        icon: Icons.edit,
        className: 'sp-action-btn sp-rename-btn',
        ariaLabel: 'Rename thread',
        onClick: (e) => {
            e.stopPropagation();
            handleRenameThread(thread);
        }
    });

    const deleteBtn = createButton({
        icon: Icons.delete,
        className: 'sp-action-btn sp-delete-btn',
        ariaLabel: 'Delete thread',
        onClick: (e) => {
            e.stopPropagation();
            handleDeleteThread(thread);
        }
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(actions);

    // Swipe to delete (touch support)
    let touchStartX = 0;
    let touchEndX = 0;

    item.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    });

    item.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        if (touchStartX - touchEndX > 100) {
            // Swiped left
            item.classList.add('sp-swipe-delete');
        } else if (touchEndX - touchStartX > 50) {
            // Swiped right - cancel
            item.classList.remove('sp-swipe-delete');
        }
    });

    return item;
}

/**
 * Handle creating a new thread
 */
async function handleNewThread() {
    console.log('[ScratchPad] New Thread button clicked');
    try {
        const { startNewThread } = await getConversationModule();
        console.log('[ScratchPad] Got startNewThread function, calling...');
        startNewThread();
        console.log('[ScratchPad] startNewThread called successfully');
    } catch (err) {
        console.error('[ScratchPad] Error starting new thread:', err);
    }
}

/**
 * Handle quick send from thread list
 * @param {string} message Message to send
 */
async function handleQuickSend(message) {
    console.log('[ScratchPad] Quick send:', message);
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    // Clear input
    const quickInput = document.querySelector('.sp-quick-input');
    if (quickInput) {
        quickInput.value = '';
    }

    // Create new thread and open it
    const thread = createThread('New Thread');
    console.log('[ScratchPad] Created thread:', thread);
    if (!thread) {
        showToast('Failed to create thread', 'error');
        return;
    }

    await saveMetadata();

    // Open the thread and send the message
    try {
        const { openThread } = await getConversationModule();
        console.log('[ScratchPad] Opening thread with message...');
        openThread(thread.id, trimmedMessage);
        console.log('[ScratchPad] Thread opened with message');
    } catch (err) {
        console.error('[ScratchPad] Error opening thread:', err);
    }
}

/**
 * Handle renaming a thread
 * @param {Object} thread Thread object
 */
async function handleRenameThread(thread) {
    const newName = await showPromptDialog('Enter new thread name:', thread.name);

    if (newName && newName.trim() && newName.trim() !== thread.name) {
        updateThread(thread.id, { name: newName.trim() });
        await saveMetadata();
        refreshThreadList();
        showToast('Thread renamed', 'success');
    }
}

/**
 * Handle deleting a thread
 * @param {Object} thread Thread object
 */
async function handleDeleteThread(thread) {
    const confirmed = await showConfirmDialog(
        `Delete thread "${thread.name}"? This cannot be undone.`,
        { confirmText: 'Delete', cancelText: 'Cancel' }
    );

    if (confirmed) {
        deleteThread(thread.id);
        await saveMetadata();
        refreshThreadList();
        showToast('Thread deleted', 'success');
    }
}

/**
 * Refresh the thread list
 */
export function refreshThreadList() {
    if (threadListContainer) {
        renderThreadList(threadListContainer);
    }
}

/**
 * Close the scratch pad drawer
 */
async function closeScratchPadDrawer() {
    const { closeScratchPad } = await import('./index.js');
    closeScratchPad();
}
