/**
 * Thread List View component for Scratch Pad extension
 */

import { getThreads, getThreadsForCurrentBranch, createThread, deleteThread, updateThread, saveMetadata } from '../storage.js';
import { getCurrentContextSettings } from '../settings.js';
import { formatTimestamp, truncateText, createButton, showConfirmDialog, showPromptDialog, showToast, Icons } from './components.js';
import { isPinnedMode, togglePinnedMode } from './index.js';

// Dynamic import to avoid circular dependency
let conversationModule = null;
async function getConversationModule() {
    if (!conversationModule) {
        conversationModule = await import('./conversation.js');
    }
    return conversationModule;
}

let threadListContainer = null;

/**
 * Render the thread list view
 * @param {HTMLElement} container Container element
 */
export function renderThreadList(container) {
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

    const threads = getThreadsForCurrentBranch();

    // Partition threads by branch relevance
    const currentBranchThreads = [];
    const offBranchThreads = [];
    const emptyThreads = [];

    for (const thread of threads) {
        if (thread.messages.length > 0) {
            currentBranchThreads.push(thread);
        } else if (thread.branchedMessages && thread.branchedMessages.length > 0) {
            offBranchThreads.push(thread);
        } else {
            emptyThreads.push(thread);
        }
    }

    if (currentBranchThreads.length === 0 && offBranchThreads.length === 0 && emptyThreads.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sp-empty-state';
        emptyState.innerHTML = `
            <div class="sp-empty-icon">${Icons.thread}</div>
            <p>No threads yet.</p>
            <p>Start a conversation to create one.</p>
        `;
        listContainer.appendChild(emptyState);
    } else {
        // Main list: threads with messages in current branch, then empty threads
        for (const thread of currentBranchThreads) {
            listContainer.appendChild(createThreadItem(thread));
        }
        for (const thread of emptyThreads) {
            listContainer.appendChild(createThreadItem(thread));
        }

        // Off-branch threads in collapsible section
        if (offBranchThreads.length > 0) {
            const details = document.createElement('details');
            details.className = 'sp-offbranch-threads';

            const summary = document.createElement('summary');
            const count = offBranchThreads.length;
            summary.textContent = `${count} thread${count !== 1 ? 's' : ''} from other branches`;
            details.appendChild(summary);

            const content = document.createElement('div');
            content.className = 'sp-offbranch-threads-content';
            for (const thread of offBranchThreads) {
                content.appendChild(createThreadItem(thread));
            }
            details.appendChild(content);

            listContainer.appendChild(details);
        }
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

    const hasNoContextMessages = Array.isArray(thread.messages) && thread.messages.some(m => m && m.noContext);
    if (hasNoContextMessages) {
        item.classList.add('sp-thread-item-nocontext');
    }

    // Main clickable area
    const mainContent = document.createElement('div');
    mainContent.className = 'sp-thread-main';
    mainContent.addEventListener('click', async () => {
        try {
            const { openThread } = await getConversationModule();
            openThread(thread.id);
            // In fullscreen mobile, hide sidebar and show main
            const fsSidebar = document.querySelector('.sp-fullscreen-sidebar');
            const fsMain = document.querySelector('.sp-fullscreen-main');
            if (fsSidebar && fsMain && window.innerWidth <= 768) {
                fsSidebar.classList.add('sp-fs-hidden');
                fsMain.classList.remove('sp-fs-hidden');
            }
        } catch (err) {
            console.error('[ScratchPad] Error opening thread:', err);
        }
    });

    // Thread name
    const nameRowEl = document.createElement('div');
    nameRowEl.className = 'sp-thread-name-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'sp-thread-name';
    nameEl.textContent = thread.name;
    nameRowEl.appendChild(nameEl);

    // Profile override indicator
    const threadProfile = thread.contextSettings?.connectionProfile;
    if (threadProfile) {
        const profileBadgeEl = document.createElement('span');
        profileBadgeEl.className = 'sp-thread-profile-indicator';
        profileBadgeEl.title = threadProfile;  // Tooltip on hover
        nameRowEl.appendChild(profileBadgeEl);
    }

    if (hasNoContextMessages) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'sp-message-badge sp-message-badge-nocontext';
        badgeEl.textContent = 'No Context';
        nameRowEl.appendChild(badgeEl);
    }

    mainContent.appendChild(nameRowEl);

    // Preview of last message
    const lastMessage = thread.messages[thread.messages.length - 1];
    if (lastMessage) {
        const previewEl = document.createElement('div');
        previewEl.className = 'sp-thread-preview';
        previewEl.textContent = truncateText(lastMessage.content, 60);
        mainContent.appendChild(previewEl);
    } else if (thread.branchedMessages && thread.branchedMessages.length > 0) {
        // Show preview from last branched message
        const lastBranched = thread.branchedMessages[thread.branchedMessages.length - 1];
        const previewEl = document.createElement('div');
        previewEl.className = 'sp-thread-preview sp-thread-preview-branched';
        previewEl.textContent = truncateText(lastBranched.content, 60);
        mainContent.appendChild(previewEl);
    } else {
        // Thread has no messages in this branch
        const previewEl = document.createElement('div');
        previewEl.className = 'sp-thread-preview sp-thread-preview-empty';
        previewEl.textContent = '(no messages in this branch)';
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
    try {
        const { startNewThread } = await getConversationModule();
        startNewThread();
        // In fullscreen mobile, show main panel
        const fsSidebar = document.querySelector('.sp-fullscreen-sidebar');
        const fsMain = document.querySelector('.sp-fullscreen-main');
        if (fsSidebar && fsMain && window.innerWidth <= 768) {
            fsSidebar.classList.add('sp-fs-hidden');
            fsMain.classList.remove('sp-fs-hidden');
        }
    } catch (err) {
        console.error('[ScratchPad] Error starting new thread:', err);
    }
}

/**
 * Handle quick send from thread list
 * @param {string} message Message to send
 */
async function handleQuickSend(message) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;

    // Clear input
    const quickInput = document.querySelector('.sp-quick-input');
    if (quickInput) {
        quickInput.value = '';
    }

    // Create new thread with current global context settings
    const contextSettings = getCurrentContextSettings();
    const thread = createThread('New Thread', contextSettings);
    if (!thread) {
        showToast('Failed to create thread', 'error');
        return;
    }

    await saveMetadata();

    // Open the thread and send the message
    try {
        const { openThread } = await getConversationModule();
        openThread(thread.id, trimmedMessage);
        // In fullscreen, ensure main is visible and refresh sidebar
        const fsSidebar = document.querySelector('.sp-fullscreen-sidebar');
        const fsMain = document.querySelector('.sp-fullscreen-main');
        if (fsSidebar && fsMain) {
            fsMain.classList.remove('sp-fs-hidden');
            if (window.innerWidth <= 768) {
                fsSidebar.classList.add('sp-fs-hidden');
            }
            const sidebarContent = fsSidebar.querySelector('.sp-drawer-content');
            if (sidebarContent) {
                renderThreadList(sidebarContent);
            }
        }
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
